import { createHash } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  immutableBlobRefSchema,
  retrievalDeltaManifestSchema,
  retrievalSnapshotManifestSchema,
  type ImmutableBlobRef,
  type RetrievalCandidate,
  type RetrievalDeltaManifest,
  type RetrievalQuery,
  type RetrievalScope,
  type RetrievalSnapshotManifest,
} from '@chief/contracts';
import {
  DynamoPersistence,
  KeyCodec,
  PersistenceConflictError,
} from '@chief/persistence-dynamodb';
import type { RetrievalIndex } from '@chief/rag';
import {
  BoundedRetrievalError,
  hashManifest,
} from '@chief/rag/bounded-retrieval';

import {
  DynamoRepositoryIngestionStore,
  type ImmutableBodyWriter,
} from './dynamo-store.js';
import { CanonicalIngestionPipeline } from './pipeline.js';
import {
  createProductionSqsHandler,
  type SqsBatchResponse,
  type SqsEvent,
} from './production-ingress.js';
import {
  loadProductionIngestionConfig,
  type ProductionIngestionConfig,
} from './runtime-config.js';
import { createIngestionHandler } from './service.js';
import type {
  CanonicalWrite,
  IngestionWorkItem,
  RetrievalMutationSink,
} from './types.js';

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tenantPath(tenantId: string): string {
  return Buffer.from(tenantId, 'utf8').toString('base64url');
}

function isPreconditionFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as {
    readonly name?: unknown;
    readonly $metadata?: { readonly httpStatusCode?: unknown };
  };
  return (
    candidate.name === 'PreconditionFailed' ||
    candidate.$metadata?.httpStatusCode === 412
  );
}

export class S3ImmutableObjectWriter implements ImmutableBodyWriter {
  public constructor(
    private readonly options: {
      readonly client: S3Client;
      readonly bucketName: string;
      readonly encryptionKeyArn: string;
    },
  ) {}

  public put(input: {
    readonly tenantId: string;
    readonly body: string;
    readonly contentHash: string;
    readonly mediaType: string;
  }): Promise<ImmutableBlobRef> {
    const bytes = new TextEncoder().encode(input.body);
    return this.putBytes({
      tenantId: input.tenantId,
      namespace: 'normalized-bodies',
      bytes,
      contentHash: input.contentHash,
      mediaType: input.mediaType,
    });
  }

  public async putBytes(input: {
    readonly tenantId: string;
    readonly namespace: 'normalized-bodies' | 'retrieval-deltas';
    readonly bytes: Uint8Array;
    readonly contentHash: string;
    readonly mediaType: string;
  }): Promise<ImmutableBlobRef> {
    if (sha256(input.bytes) !== input.contentHash)
      throw new Error('IMMUTABLE_OBJECT_HASH_MISMATCH');
    const objectKey = `${input.namespace}/${tenantPath(input.tenantId)}/${input.contentHash}`;
    let objectVersion: string | undefined;
    try {
      const output = await this.options.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucketName,
          Key: objectKey,
          Body: input.bytes,
          ContentLength: input.bytes.byteLength,
          ContentType: input.mediaType,
          ChecksumSHA256: Buffer.from(input.contentHash, 'hex').toString(
            'base64',
          ),
          IfNoneMatch: '*',
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: this.options.encryptionKeyArn,
        }),
      );
      objectVersion = output.VersionId;
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      const existing = await this.options.client.send(
        new HeadObjectCommand({
          Bucket: this.options.bucketName,
          Key: objectKey,
          ChecksumMode: 'ENABLED',
        }),
      );
      const expectedChecksum = Buffer.from(input.contentHash, 'hex').toString(
        'base64',
      );
      if (
        existing.ContentLength !== input.bytes.byteLength ||
        existing.ChecksumSHA256 !== expectedChecksum
      )
        throw new Error('IMMUTABLE_OBJECT_CONFLICT', { cause: error });
      objectVersion = existing.VersionId;
    }
    return immutableBlobRefSchema.parse({
      schemaVersion: '1',
      tenantId: input.tenantId,
      bucketRef: this.options.bucketName,
      objectKey,
      objectVersion: objectVersion ?? input.contentHash,
      contentHash: input.contentHash,
      byteLength: input.bytes.byteLength,
      mediaType: input.mediaType,
      encryptionKeyRef: this.options.encryptionKeyArn,
      retentionPolicyVersion: '1',
    });
  }
}

export class S3RetrievalMutationSink implements RetrievalMutationSink {
  public constructor(private readonly objects: S3ImmutableObjectWriter) {}

  public async stage(input: {
    readonly workItem: IngestionWorkItem;
    readonly canonical: CanonicalWrite;
  }): Promise<RetrievalDeltaManifest> {
    const operation = input.canonical.deleted ? 'delete' : 'upsert';
    const text =
      input.canonical.source === 'asana'
        ? `${input.canonical.title}\n${input.canonical.notes ?? ''}`.trim()
        : input.canonical.retrievalText;
    const payload = `${JSON.stringify({
      schemaVersion: '1',
      operation,
      dedupeKey: input.canonical.dedupeKey,
      text,
    })}\n`;
    const bytes = new TextEncoder().encode(payload);
    const contentHash = sha256(bytes);
    const object = await this.objects.putBytes({
      tenantId: input.workItem.tenantId,
      namespace: 'retrieval-deltas',
      bytes,
      contentHash,
      mediaType: 'application/x-ndjson',
    });
    const createdAt =
      input.canonical.source === 'asana'
        ? input.canonical.providerTimestamp
        : input.canonical.revision.ingestedAt;
    const sequence = Number.parseInt(
      sha256(input.canonical.dedupeKey).slice(0, 8),
      16,
    );
    const candidate = retrievalDeltaManifestSchema.parse({
      schemaVersion: '1',
      tenantId: input.workItem.tenantId,
      role: 'factual',
      scopeHash: input.workItem.scopeHash,
      baseGeneration: 1,
      authorizationEpoch: input.workItem.authorizationEpoch,
      sequenceStart: sequence,
      sequenceEnd: sequence,
      changeCount: 1,
      byteLength: bytes.byteLength,
      object,
      manifestHash: sha256('pending-manifest-hash'),
      createdAt,
    });
    return retrievalDeltaManifestSchema.parse({
      ...candidate,
      manifestHash: hashManifest(candidate),
    });
  }
}

/**
 * Durable ingestion-side registration of immutable retrieval manifests. Query
 * hydration remains owned by the bounded RetrievalIndex runtime.
 */
export class DurableRetrievalRegistrationIndex implements RetrievalIndex {
  public constructor(
    private readonly persistence: DynamoPersistence,
    private readonly retrievalTableName: string,
  ) {}

  public async applySnapshot(manifest: RetrievalSnapshotManifest): Promise<{
    readonly kind: 'snapshot';
    readonly tenantId: string;
    readonly scopeHash: string;
    readonly role: RetrievalScope['role'];
    readonly generation: number;
    readonly authorizationEpoch: number;
    readonly manifestHash: string;
    readonly appliedAt: string;
  }> {
    const safe = retrievalSnapshotManifestSchema.parse(manifest);
    await this.register(
      safe.tenantId,
      safe.scopeHash,
      `snapshot:${safe.manifestHash}`,
      safe,
    );
    return {
      kind: 'snapshot',
      tenantId: safe.tenantId,
      scopeHash: safe.scopeHash,
      role: safe.role,
      generation: safe.generation,
      authorizationEpoch: safe.authorizationEpoch,
      manifestHash: safe.manifestHash,
      appliedAt: safe.createdAt,
    };
  }

  public async applyDelta(manifest: RetrievalDeltaManifest): Promise<{
    readonly kind: 'delta';
    readonly tenantId: string;
    readonly scopeHash: string;
    readonly role: RetrievalScope['role'];
    readonly baseGeneration: number;
    readonly authorizationEpoch: number;
    readonly sequenceEnd: number;
    readonly manifestHash: string;
    readonly appliedAt: string;
  }> {
    const safe = retrievalDeltaManifestSchema.parse(manifest);
    if (hashManifest(safe) !== safe.manifestHash)
      throw new BoundedRetrievalError('INDEX_REFRESH_REQUIRED');
    await this.register(
      safe.tenantId,
      safe.scopeHash,
      `delta:${safe.manifestHash}`,
      safe,
    );
    return {
      kind: 'delta',
      tenantId: safe.tenantId,
      scopeHash: safe.scopeHash,
      role: safe.role,
      baseGeneration: safe.baseGeneration,
      authorizationEpoch: safe.authorizationEpoch,
      sequenceEnd: safe.sequenceEnd,
      manifestHash: safe.manifestHash,
      appliedAt: safe.createdAt,
    };
  }

  public query(_input: RetrievalQuery): Promise<readonly RetrievalCandidate[]> {
    return Promise.reject(new BoundedRetrievalError('INDEX_REFRESH_REQUIRED'));
  }

  public health(scope: RetrievalScope): Promise<{
    readonly status: 'unavailable';
    readonly scope: RetrievalScope;
    readonly indexedChunkCount: 0;
    readonly pendingDeltaCount: 0;
    readonly observedAt: string;
    readonly reasonCode: 'INDEX_REFRESH_REQUIRED';
  }> {
    return Promise.resolve({
      status: 'unavailable',
      scope,
      indexedChunkCount: 0,
      pendingDeltaCount: 0,
      observedAt: new Date(0).toISOString(),
      reasonCode: 'INDEX_REFRESH_REQUIRED',
    });
  }

  private async register(
    tenantId: string,
    scopeHash: string,
    factId: string,
    manifest: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      await this.persistence.putImmutableFactWithEvent({
        tableName: this.retrievalTableName,
        tenantId,
        accountId: `retrieval-${scopeHash.slice(0, 32)}`,
        fact: {
          factType: 'retrieval-manifest-registration',
          factId,
          attributes: { manifest },
        },
        eventOutbox: {
          outboxId: `retrieval:${factId}`,
          attributes: {
            eventType: 'retrieval.manifest.registered',
            aggregateId: factId,
            payloadHash: manifest.manifestHash,
            status: 'pending',
          },
        },
      });
    } catch (error) {
      if (!(error instanceof PersistenceConflictError)) throw error;
    }
  }
}

interface DigestSecret {
  readonly version: string;
  readonly key: string;
}

function parseDigestSecret(value: string): DigestSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('DIGEST_KEY_SECRET_INVALID');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('DIGEST_KEY_SECRET_INVALID');
  const record = parsed as Readonly<Record<string, unknown>>;
  if (
    typeof record.version !== 'string' ||
    typeof record.key !== 'string' ||
    record.key.length < 32
  )
    throw new Error('DIGEST_KEY_SECRET_INVALID');
  return { version: record.version, key: record.key };
}

async function loadDigestKey(
  client: SecretsManagerClient,
  secretArn: string,
): Promise<KeyCodec> {
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (response.SecretString === undefined)
    throw new Error('DIGEST_KEY_SECRET_INVALID');
  const material = parseDigestSecret(response.SecretString);
  return new KeyCodec({
    current: {
      version: material.version,
      secret: new TextEncoder().encode(material.key),
    },
  });
}

export async function createAwsProductionIngestionHandler(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<(event: SqsEvent) => Promise<SqsBatchResponse>> {
  const config: ProductionIngestionConfig =
    loadProductionIngestionConfig(environment);
  const keyCodec = await loadDigestKey(
    new SecretsManagerClient({}),
    config.digestKeySecretArn,
  );
  const persistence = new DynamoPersistence(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    keyCodec,
  );
  const objects = new S3ImmutableObjectWriter({
    client: new S3Client({}),
    bucketName: config.snapshotBucketName,
    encryptionKeyArn: config.productDataKeyArn,
  });
  const pipeline = new CanonicalIngestionPipeline({
    store: new DynamoRepositoryIngestionStore({
      persistence,
      bodyWriter: objects,
      coreTableName: config.coreTableName,
      connectorRuntimeTableName: config.connectorRuntimeTableName,
      threadLookupIndexName: config.threadLookupIndexName,
      identityLookupIndexName: config.identityLookupIndexName,
      asanaTopicLookupIndexName: config.asanaTopicLookupIndexName,
    }),
    keyCodec,
    retrievalSink: new S3RetrievalMutationSink(objects),
    retrievalIndex: new DurableRetrievalRegistrationIndex(
      persistence,
      config.retrievalTableName,
    ),
  });
  return createProductionSqsHandler(
    createIngestionHandler(pipeline),
    config.connectorBindings,
  );
}
