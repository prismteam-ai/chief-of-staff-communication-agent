import { createHash } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  GetObjectCommand,
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
  canonicalRetrievalSourceAuthoritySchema,
  immutableBlobRefSchema,
  retrievalScopeSchema,
  type ImmutableBlobRef,
  type RetrievalScope,
} from '@chief/contracts';
import { DynamoPersistence, KeyCodec } from '@chief/persistence-dynamodb';
import {
  DeterministicEffectDisabledEmbedding,
  DurableRetrievalCompactor,
  DynamoS3RetrievalAuthority,
  BoundedRetrievalError,
  canonicalJson,
  listBoundedStagedRetrieval,
  serializeBinary32Le,
  sha256Bytes,
  validateStagedRetrievalMutation,
  type EffectDisabledEmbeddingProducer,
  type ImmutableRetrievalArtifactStore,
  type DurableRetrievalHeadStore,
  type RetrievalStagingCatalog,
  type StagedRetrievalMutationV1,
  type RetrievalStagingRegistrar,
} from '@chief/rag';

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

function evaluatorRelationTopic(
  canonical: CanonicalWrite,
): 'release_readiness' | 'board_metrics' | 'communication_context' | undefined {
  if (canonical.source === 'asana') return undefined;
  if (
    canonical.source === 'gmail' &&
    canonical.thread.threadId ===
      'thr_94f02c2953e5253d7f62f514efffdda78aa29090' &&
    canonical.contentHash ===
      '3ec5dd5bdc24a0edef761555d9100bc853213236ec37ed74a80923f287fcc4cc'
  )
    return 'release_readiness';
  if (
    canonical.source === 'gmail' &&
    canonical.thread.threadId ===
      'thr_309a81cf66fffd346b95eccaf016494a30abd88f' &&
    canonical.contentHash ===
      '49ee3e715f21ab40d361d2aa06f9871cb1bf5cb3731beb9d212f9944e02fb7d0'
  )
    return 'board_metrics';
  return 'communication_context';
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

export class S3ImmutableObjectWriter
  implements ImmutableBodyWriter, ImmutableRetrievalArtifactStore
{
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
    readonly namespace:
      'normalized-bodies' | 'retrieval-staged' | 'retrieval-snapshots';
    readonly scopeHash?: string;
    readonly bytes: Uint8Array;
    readonly contentHash: string;
    readonly mediaType: string;
  }): Promise<ImmutableBlobRef> {
    if (sha256(input.bytes) !== input.contentHash)
      throw new Error('IMMUTABLE_OBJECT_HASH_MISMATCH');
    const objectKey = `${input.namespace}/${tenantPath(input.tenantId)}/${input.scopeHash === undefined ? '' : `${input.scopeHash}/`}${input.contentHash}`;
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

  public putImmutableObject(input: {
    readonly tenantId: string;
    readonly scopeHash: string;
    readonly namespace: 'retrieval-staged' | 'retrieval-snapshots';
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<ImmutableBlobRef> {
    return this.putBytes({
      ...input,
      contentHash: sha256(input.bytes),
    });
  }

  public async getImmutableObject(ref: ImmutableBlobRef): Promise<Uint8Array> {
    if (ref.bucketRef !== this.options.bucketName)
      throw new Error('IMMUTABLE_OBJECT_SCOPE_MISMATCH');
    const output = await this.options.client.send(
      new GetObjectCommand({
        Bucket: this.options.bucketName,
        Key: ref.objectKey,
        VersionId: ref.objectVersion,
        ChecksumMode: 'ENABLED',
      }),
    );
    if (output.Body === undefined) throw new Error('IMMUTABLE_OBJECT_MISSING');
    const bytes = new Uint8Array(await output.Body.transformToByteArray());
    if (
      bytes.byteLength !== ref.byteLength ||
      sha256(bytes) !== ref.contentHash
    )
      throw new Error('IMMUTABLE_OBJECT_HASH_MISMATCH');
    return bytes;
  }
}

export class S3RetrievalMutationSink implements RetrievalMutationSink {
  public constructor(
    private readonly objects: ImmutableRetrievalArtifactStore,
    private readonly embeddings: EffectDisabledEmbeddingProducer = new DeterministicEffectDisabledEmbedding(),
    private readonly authorizedScope?: RetrievalScope,
  ) {}

  public async stage(input: {
    readonly workItem: IngestionWorkItem;
    readonly canonical: CanonicalWrite;
  }): Promise<StagedRetrievalMutationV1> {
    const itemScope = retrievalScopeSchema.parse({
      derivation: 'server_grants',
      tenantId: input.workItem.tenantId,
      accountIds: [input.workItem.accountId],
      brandIds: [...(input.workItem.brandIds ?? [])],
      authorizationEpoch: input.workItem.authorizationEpoch,
      scopeHash: input.workItem.scopeHash,
      role: 'factual',
    });
    const scope =
      this.authorizedScope === undefined
        ? itemScope
        : retrievalScopeSchema.parse(this.authorizedScope);
    if (
      scope.tenantId !== input.workItem.tenantId ||
      scope.authorizationEpoch !== input.workItem.authorizationEpoch ||
      scope.scopeHash !== input.workItem.scopeHash ||
      scope.role !== 'factual' ||
      !scope.accountIds.some(
        (accountId) => accountId === input.workItem.accountId,
      ) ||
      (input.workItem.brandIds ?? []).some(
        (brandId) =>
          !scope.brandIds.some(
            (authorizedBrandId) => authorizedBrandId === brandId,
          ),
      )
    )
      throw new BoundedRetrievalError('ACCESS_DENIED');
    const operation = input.canonical.deleted ? 'delete' : 'upsert';
    const text =
      input.canonical.source === 'asana'
        ? `${input.canonical.title}\n${input.canonical.notes ?? ''}`.trim()
        : input.canonical.retrievalText;
    const createdAt =
      input.canonical.source === 'asana'
        ? input.canonical.providerTimestamp
        : input.canonical.revision.ingestedAt;
    const stagingOrdinal = `${createdAt}#${sha256(input.canonical.dedupeKey)}`;
    const relationTopic = evaluatorRelationTopic(input.canonical);
    const record = {
      schemaVersion: '1' as const,
      chunkId: input.canonical.dedupeKey,
      sourceId: input.canonical.dedupeKey,
      sourceVersion: input.canonical.contentHash,
      text,
      tokenCount:
        text.length === 0
          ? 0
          : (text
              .normalize('NFKC')
              .toLocaleLowerCase('en-US')
              .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0),
      exactEntityRefs:
        input.canonical.source === 'asana'
          ? [input.canonical.providerObjectId, ...input.canonical.projectIds]
          : [input.canonical.thread.threadId],
      citationLabel:
        input.canonical.source === 'asana'
          ? 'Asana work evidence'
          : `${input.canonical.source} communication evidence`,
      contentHash: sha256Bytes(text),
      state:
        operation === 'upsert' ? ('active' as const) : ('tombstoned' as const),
      mutationOrdinal: stagingOrdinal,
      sourceAuthority: canonicalRetrievalSourceAuthoritySchema.parse(
        input.canonical.source === 'asana'
          ? {
              contractVersion: 'chief-source-authority.v1',
              verifiedBy: 'canonical_ingestion',
              sourceClass: 'asana',
              sourceKind: 'asana',
              relationKind: 'explicit_related_work',
            }
          : {
              contractVersion: 'chief-source-authority.v1',
              verifiedBy: 'canonical_ingestion',
              sourceClass: 'communication',
              sourceKind: input.canonical.source,
              relationKind: 'canonical_thread',
              ...(relationTopic === undefined ? {} : { relationTopic }),
            },
      ),
    };
    const document = {
      schemaVersion: '1' as const,
      stagingOrdinal,
      operation,
      record,
      vectorBinary32LeBase64: Buffer.from(
        serializeBinary32Le(this.embeddings.embed(text)),
      ).toString('base64'),
    };
    const bytes = new TextEncoder().encode(canonicalJson([document]));
    const object = await this.objects.putImmutableObject({
      tenantId: input.workItem.tenantId,
      scopeHash: input.workItem.scopeHash,
      namespace: 'retrieval-staged',
      bytes,
      mediaType: 'application/vnd.chief.retrieval-staged+json;version=1',
    });
    return validateStagedRetrievalMutation({
      contractVersion: 'chief-retrieval.v1',
      kind: 'staged-mutation',
      scope,
      mutationId: sha256Bytes(bytes),
      stagingOrdinal,
      changeCount: 1,
      byteLength: bytes.byteLength,
      object,
      createdAt,
    });
  }
}

export class CompactingRetrievalRegistrar implements RetrievalStagingRegistrar {
  public constructor(
    private readonly authority: RetrievalStagingRegistrar &
      RetrievalStagingCatalog &
      DurableRetrievalHeadStore,
    private readonly compactor: DurableRetrievalCompactor,
  ) {}

  public async register(manifest: StagedRetrievalMutationV1): Promise<void> {
    await this.authority.register(manifest);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const head = await this.authority.getHead(manifest.scope);
      const staged = await listBoundedStagedRetrieval({
        catalog: this.authority,
        scope: manifest.scope,
      });
      try {
        await this.compactor.compactAndPromote({
          scope: manifest.scope,
          staged,
          ...(head === undefined
            ? {}
            : { expectedHeadManifestHash: head.manifest.manifestHash }),
        });
        return;
      } catch (error) {
        if (
          !(error instanceof BoundedRetrievalError) ||
          error.code !== 'INDEX_REFRESH_REQUIRED' ||
          attempt === 2
        )
          throw error;
      }
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
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const persistence = new DynamoPersistence(documentClient, keyCodec);
  const objects = new S3ImmutableObjectWriter({
    client: new S3Client({}),
    bucketName: config.snapshotBucketName,
    encryptionKeyArn: config.productDataKeyArn,
  });
  const retrievalAuthority = new DynamoS3RetrievalAuthority({
    client: documentClient,
    tableName: config.retrievalTableName,
  });
  const retrievalProducer = new DeterministicEffectDisabledEmbedding();
  const retrievalCompactor = new DurableRetrievalCompactor({
    artifacts: objects,
    heads: retrievalAuthority,
    memory: {
      sample: () => ({
        rssBytes: process.memoryUsage().rss,
        limitBytes:
          Number(environment.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? '1024') *
          1024 *
          1024,
      }),
    },
    embeddingProfileManifestHash: retrievalProducer.profileManifestHash,
    embeddingProfileId: retrievalProducer.profileId,
    vectorDimension: retrievalProducer.dimension,
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
    retrievalSink: new S3RetrievalMutationSink(objects, retrievalProducer),
    retrievalRegistrar: new CompactingRetrievalRegistrar(
      retrievalAuthority,
      retrievalCompactor,
    ),
  });
  return createProductionSqsHandler(
    createIngestionHandler(pipeline),
    config.connectorBindings,
  );
}
