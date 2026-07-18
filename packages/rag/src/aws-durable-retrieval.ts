import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  immutableBlobRefSchema,
  type ImmutableBlobRef,
} from '@chief/contracts/storage';
import type {
  RetrievalScope,
  RetrievalSnapshotManifest,
} from '@chief/contracts/knowledge';

import {
  BoundedDynamoS3RetrievalIndex,
  BoundedRetrievalError,
  decodeBinary32Vectors,
  type AuthorizationHydration,
  type DeltaPage,
  type MemoryProbe,
  type RetrievalAuthorityReader,
} from './bounded-retrieval.js';
import {
  DeterministicEffectDisabledEmbedding,
  canonicalJson,
  persistEffectDisabledQueryVector,
  prepareEffectDisabledQueryVector,
  retrievalDynamoEntityPrefixV1,
  retrievalDynamoKeyV1,
  serializeBinary32Le,
  sha256Bytes,
  validateStagedRetrievalMutation,
  type DurableRetrievalHeadStore,
  type DurableRetrievalHeadV1,
  type ImmutableRetrievalArtifactStore,
  type PersistedQueryVectorStore,
  type RetrievalStagingRegistrar,
  type RetrievalStagingCatalog,
  type StagedRetrievalPageV1,
  type StagedRetrievalMutationV1,
} from './durable-retrieval.js';

function conditionalFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as {
    readonly name?: unknown;
    readonly $metadata?: { readonly httpStatusCode?: unknown };
  };
  return (
    candidate.name === 'ConditionalCheckFailedException' ||
    candidate.name === 'TransactionCanceledException' ||
    candidate.name === 'PreconditionFailed' ||
    candidate.$metadata?.httpStatusCode === 412
  );
}

function sameScope(left: RetrievalScope, right: RetrievalScope): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameAuthorityDomain(
  left: RetrievalScope,
  right: RetrievalScope,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.scopeHash === right.scopeHash &&
    left.role === right.role
  );
}

function tenantPath(tenantId: string): string {
  return Buffer.from(tenantId, 'utf8').toString('base64url');
}

export class S3ImmutableRetrievalArtifactStore implements ImmutableRetrievalArtifactStore {
  public constructor(
    private readonly options: {
      readonly client: S3Client;
      readonly bucketName: string;
      readonly encryptionKeyArn?: string;
    },
  ) {}

  public async getImmutableObject(ref: ImmutableBlobRef): Promise<Uint8Array> {
    if (ref.bucketRef !== this.options.bucketName)
      throw new BoundedRetrievalError('CORRUPT_SNAPSHOT');
    const output = await this.options.client.send(
      new GetObjectCommand({
        Bucket: this.options.bucketName,
        Key: ref.objectKey,
        VersionId: ref.objectVersion,
        ChecksumMode: 'ENABLED',
      }),
    );
    if (output.Body === undefined)
      throw new BoundedRetrievalError('CORRUPT_SNAPSHOT');
    const bytes = new Uint8Array(await output.Body.transformToByteArray());
    if (
      bytes.byteLength !== ref.byteLength ||
      sha256Bytes(bytes) !== ref.contentHash
    )
      throw new BoundedRetrievalError('CORRUPT_SNAPSHOT');
    return bytes;
  }

  public async putImmutableObject(input: {
    readonly tenantId: string;
    readonly scopeHash: string;
    readonly namespace: 'retrieval-staged' | 'retrieval-snapshots';
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<ImmutableBlobRef> {
    if (this.options.encryptionKeyArn === undefined)
      throw new Error('RETRIEVAL_ARTIFACT_WRITES_DISABLED');
    const contentHash = sha256Bytes(input.bytes);
    const objectKey = `${input.namespace}/${tenantPath(input.tenantId)}/${input.scopeHash}/${contentHash}`;
    let objectVersion: string | undefined;
    try {
      const output = await this.options.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucketName,
          Key: objectKey,
          Body: input.bytes,
          ContentLength: input.bytes.byteLength,
          ContentType: input.mediaType,
          ChecksumSHA256: Buffer.from(contentHash, 'hex').toString('base64'),
          IfNoneMatch: '*',
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: this.options.encryptionKeyArn,
        }),
      );
      objectVersion = output.VersionId;
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      const existing = await this.options.client.send(
        new HeadObjectCommand({
          Bucket: this.options.bucketName,
          Key: objectKey,
          ChecksumMode: 'ENABLED',
        }),
      );
      if (
        existing.ContentLength !== input.bytes.byteLength ||
        existing.ChecksumSHA256 !==
          Buffer.from(contentHash, 'hex').toString('base64')
      )
        throw new BoundedRetrievalError('CORRUPT_SNAPSHOT');
      objectVersion = existing.VersionId;
    }
    return immutableBlobRefSchema.parse({
      schemaVersion: '1',
      tenantId: input.tenantId,
      bucketRef: this.options.bucketName,
      objectKey,
      objectVersion: objectVersion ?? contentHash,
      contentHash,
      byteLength: input.bytes.byteLength,
      mediaType: input.mediaType,
      encryptionKeyRef: this.options.encryptionKeyArn,
      retentionPolicyVersion: '1',
    });
  }
}

export class DynamoS3RetrievalAuthority
  implements
    RetrievalAuthorityReader,
    DurableRetrievalHeadStore,
    PersistedQueryVectorStore,
    RetrievalStagingRegistrar,
    RetrievalStagingCatalog
{
  public constructor(
    private readonly options: {
      readonly client: DynamoDBDocumentClient;
      readonly tableName: string;
    },
  ) {}

  public async getHead(
    scope: RetrievalScope,
  ): Promise<DurableRetrievalHeadV1 | undefined> {
    const output = await this.options.client.send(
      new GetCommand({
        TableName: this.options.tableName,
        Key: this.key(scope, 'head'),
        ConsistentRead: true,
      }),
    );
    if (output.Item === undefined) return undefined;
    const head = output.Item.head as DurableRetrievalHeadV1 | undefined;
    if (
      head === undefined ||
      head.contractVersion !== 'chief-retrieval.v1' ||
      head.kind !== 'snapshot-head' ||
      !sameAuthorityDomain(head.scope, scope) ||
      head.manifest.manifestHash !== output.Item.manifestHash
    )
      throw new BoundedRetrievalError('CORRUPT_SNAPSHOT');
    if (head.scope.authorizationEpoch > scope.authorizationEpoch)
      throw new BoundedRetrievalError('ACCESS_DENIED');
    return head;
  }

  public async compareAndSwapHead(input: {
    readonly scope: RetrievalScope;
    readonly expectedManifestHash?: string;
    readonly next: DurableRetrievalHeadV1;
  }): Promise<'promoted' | 'stale'> {
    if (!sameScope(input.scope, input.next.scope))
      throw new BoundedRetrievalError('ACCESS_DENIED');
    const key = this.key(input.scope, 'head');
    const epochKey = this.key(input.scope, 'authorization-epoch');
    const headItem = {
      ...key,
      tenantId: input.scope.tenantId,
      scopeHash: input.scope.scopeHash,
      role: input.scope.role,
      authorizationEpoch: input.scope.authorizationEpoch,
      manifestHash: input.next.manifest.manifestHash,
      head: input.next,
    };
    try {
      await this.options.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.options.tableName,
                Key: epochKey,
                ConditionExpression:
                  '#tenant = :tenant AND #scopeHash = :scopeHash AND #role = :role AND #epoch = :epoch',
                ExpressionAttributeNames: {
                  '#tenant': 'tenantId',
                  '#scopeHash': 'scopeHash',
                  '#role': 'role',
                  '#epoch': 'authorizationEpoch',
                },
                ExpressionAttributeValues: {
                  ':tenant': input.scope.tenantId,
                  ':scopeHash': input.scope.scopeHash,
                  ':role': input.scope.role,
                  ':epoch': input.scope.authorizationEpoch,
                },
              },
            },
            input.expectedManifestHash === undefined
              ? {
                  Put: {
                    TableName: this.options.tableName,
                    Item: headItem,
                    ConditionExpression:
                      'attribute_not_exists(PK) AND attribute_not_exists(SK)',
                  },
                }
              : {
                  Put: {
                    TableName: this.options.tableName,
                    Item: headItem,
                    ConditionExpression:
                      '#tenant = :tenant AND #scopeHash = :scopeHash AND #role = :role AND #manifestHash = :expectedManifestHash',
                    ExpressionAttributeNames: {
                      '#tenant': 'tenantId',
                      '#scopeHash': 'scopeHash',
                      '#role': 'role',
                      '#manifestHash': 'manifestHash',
                    },
                    ExpressionAttributeValues: {
                      ':tenant': input.scope.tenantId,
                      ':scopeHash': input.scope.scopeHash,
                      ':role': input.scope.role,
                      ':expectedManifestHash': input.expectedManifestHash,
                    },
                  },
                },
          ],
        }),
      );
      return 'promoted';
    } catch (error) {
      if (conditionalFailure(error)) return 'stale';
      throw error;
    }
  }

  public async register(manifest: StagedRetrievalMutationV1): Promise<void> {
    const safe = validateStagedRetrievalMutation(manifest);
    await this.advanceAuthorizationEpoch(safe.scope);
    try {
      await this.options.client.send(
        new PutCommand({
          TableName: this.options.tableName,
          Item: {
            ...this.key(
              safe.scope,
              this.stagedEntity(safe.scope, safe.mutationId),
            ),
            tenantId: safe.scope.tenantId,
            scopeHash: safe.scope.scopeHash,
            role: safe.scope.role,
            authorizationEpoch: safe.scope.authorizationEpoch,
            mutationId: safe.mutationId,
            stagingOrdinal: safe.stagingOrdinal,
            manifest: safe,
            immutable: true,
          },
          ConditionExpression:
            'attribute_not_exists(PK) AND attribute_not_exists(SK)',
        }),
      );
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      const existing = await this.options.client.send(
        new GetCommand({
          TableName: this.options.tableName,
          Key: this.key(
            safe.scope,
            this.stagedEntity(safe.scope, safe.mutationId),
          ),
          ConsistentRead: true,
        }),
      );
      if (canonicalJson(existing.Item?.manifest) !== canonicalJson(safe))
        throw new BoundedRetrievalError('INDEX_REFRESH_REQUIRED');
    }
  }

  public async listStaged(input: {
    readonly scope: RetrievalScope;
    readonly limit: number;
    readonly nextToken?: string;
  }): Promise<StagedRetrievalPageV1> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 256
    )
      throw new BoundedRetrievalError('RESOURCE_LIMIT');
    const stagedKind = `staged-${String(input.scope.authorizationEpoch)}`;
    const prefix = retrievalDynamoEntityPrefixV1(input.scope, stagedKind);
    const output = await this.options.client.send(
      new QueryCommand({
        TableName: this.options.tableName,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
        ExpressionAttributeValues: {
          ':pk': prefix.PK,
          ':prefix': prefix.SKPrefix,
        },
        ...(input.nextToken === undefined
          ? {}
          : {
              ExclusiveStartKey: this.key(
                input.scope,
                `${stagedKind}:${input.nextToken}`,
              ),
            }),
        Limit: input.limit,
        ConsistentRead: true,
        ScanIndexForward: true,
      }),
    );
    const manifests = (output.Items ?? []).map((item) => {
      const manifest = validateStagedRetrievalMutation(item.manifest);
      if (!sameScope(manifest.scope, input.scope))
        throw new BoundedRetrievalError('ACCESS_DENIED');
      return manifest;
    });
    const last = manifests.at(-1);
    if (output.LastEvaluatedKey !== undefined && last === undefined)
      throw new BoundedRetrievalError('INDEX_REFRESH_REQUIRED');
    return Object.freeze({
      manifests: Object.freeze(manifests),
      ...(output.LastEvaluatedKey === undefined || last === undefined
        ? {}
        : { nextToken: last.mutationId }),
    });
  }

  public async getSnapshotHead(
    scope: RetrievalScope,
  ): Promise<RetrievalSnapshotManifest | undefined> {
    return (await this.getHead(scope))?.manifest;
  }

  public async getAuthorizationEpoch(scope: RetrievalScope): Promise<number> {
    const output = await this.options.client.send(
      new GetCommand({
        TableName: this.options.tableName,
        Key: this.key(scope, 'authorization-epoch'),
        ConsistentRead: true,
      }),
    );
    if (
      output.Item === undefined ||
      output.Item.tenantId !== scope.tenantId ||
      output.Item.scopeHash !== scope.scopeHash ||
      output.Item.role !== scope.role ||
      !Number.isSafeInteger(output.Item.authorizationEpoch) ||
      output.Item.authorizationEpoch < 1
    )
      throw new BoundedRetrievalError('ACCESS_DENIED');
    return output.Item.authorizationEpoch as number;
  }

  public async advanceAuthorizationEpoch(scope: RetrievalScope): Promise<void> {
    try {
      await this.options.client.send(
        new UpdateCommand({
          TableName: this.options.tableName,
          Key: this.key(scope, 'authorization-epoch'),
          ConditionExpression:
            'attribute_not_exists(#epoch) OR #epoch <= :nextEpoch',
          UpdateExpression:
            'SET #tenant = :tenant, #scopeHash = :scopeHash, #role = :role, #epoch = :nextEpoch',
          ExpressionAttributeNames: {
            '#tenant': 'tenantId',
            '#scopeHash': 'scopeHash',
            '#role': 'role',
            '#epoch': 'authorizationEpoch',
          },
          ExpressionAttributeValues: {
            ':tenant': scope.tenantId,
            ':scopeHash': scope.scopeHash,
            ':role': scope.role,
            ':nextEpoch': scope.authorizationEpoch,
          },
        }),
      );
    } catch (error) {
      if (conditionalFailure(error))
        throw new BoundedRetrievalError('ACCESS_DENIED');
      throw error;
    }
  }

  public queryDeltas(input: {
    readonly scope: RetrievalScope;
    readonly baseGeneration: number;
    readonly afterSequence: number;
    readonly pageToken?: string;
  }): Promise<DeltaPage> {
    if (input.pageToken !== undefined)
      throw new BoundedRetrievalError('INDEX_REFRESH_REQUIRED');
    return Promise.resolve({ manifests: [] });
  }

  public async getExactChunkIds(input: {
    readonly scope: RetrievalScope;
    readonly expectedAuthorizationEpoch: number;
    readonly exactEntityRefs: readonly string[];
  }): Promise<readonly string[]> {
    if (
      input.expectedAuthorizationEpoch !== input.scope.authorizationEpoch ||
      input.exactEntityRefs.length > 100
    )
      throw new BoundedRetrievalError('ACCESS_DENIED');
    const ids = new Set<string>();
    for (const reference of input.exactEntityRefs) {
      const output = await this.options.client.send(
        new GetCommand({
          TableName: this.options.tableName,
          Key: this.key(input.scope, `exact:${sha256Bytes(reference)}`),
          ConsistentRead: true,
        }),
      );
      if (output.Item === undefined) continue;
      if (
        output.Item.authorizationEpoch !== input.expectedAuthorizationEpoch ||
        !Array.isArray(output.Item.chunkIds)
      )
        throw new BoundedRetrievalError('ACCESS_DENIED');
      for (const chunkId of output.Item.chunkIds) {
        if (typeof chunkId !== 'string')
          throw new BoundedRetrievalError('ACCESS_DENIED');
        ids.add(chunkId);
      }
    }
    return Object.freeze([...ids].sort());
  }

  public async hydrateAuthorization(input: {
    readonly scope: RetrievalScope;
    readonly expectedAuthorizationEpoch: number;
    readonly chunkIds: readonly string[];
  }): Promise<readonly AuthorizationHydration[]> {
    if (
      input.expectedAuthorizationEpoch !== input.scope.authorizationEpoch ||
      input.chunkIds.length > 10_000
    )
      throw new BoundedRetrievalError('ACCESS_DENIED');
    const hydrated: AuthorizationHydration[] = [];
    for (let offset = 0; offset < input.chunkIds.length; offset += 100) {
      const batch = input.chunkIds.slice(offset, offset + 100);
      const output = await this.options.client.send(
        new BatchGetCommand({
          RequestItems: {
            [this.options.tableName]: {
              Keys: batch.map((chunkId) =>
                this.key(input.scope, `chunk:${chunkId}`),
              ),
              ConsistentRead: true,
            },
          },
        }),
      );
      if (
        Object.values(output.UnprocessedKeys ?? {}).some(
          (value) => (value.Keys?.length ?? 0) > 0,
        )
      )
        throw new BoundedRetrievalError('ACCESS_DENIED');
      for (const item of output.Responses?.[this.options.tableName] ?? []) {
        const value = item.hydration as AuthorizationHydration | undefined;
        if (
          value === undefined ||
          item.authorizationEpoch !== input.expectedAuthorizationEpoch
        )
          throw new BoundedRetrievalError('ACCESS_DENIED');
        hydrated.push(value);
      }
    }
    return Object.freeze(hydrated);
  }

  public async putQueryVector(input: {
    readonly scope: RetrievalScope;
    readonly queryHash: string;
    readonly embeddingProfileManifestHash: string;
    readonly vector: Float32Array;
  }): Promise<void> {
    const encoded = Buffer.from(serializeBinary32Le(input.vector)).toString(
      'base64',
    );
    const entityId = this.queryEntity(
      input.scope,
      input.embeddingProfileManifestHash,
      input.queryHash,
    );
    const item = {
      ...this.key(input.scope, entityId),
      tenantId: input.scope.tenantId,
      scopeHash: input.scope.scopeHash,
      role: input.scope.role,
      authorizationEpoch: input.scope.authorizationEpoch,
      queryHash: input.queryHash,
      embeddingProfileManifestHash: input.embeddingProfileManifestHash,
      dimension: input.vector.length,
      vectorBinary32LeBase64: encoded,
      immutable: true,
    };
    try {
      await this.options.client.send(
        new PutCommand({
          TableName: this.options.tableName,
          Item: item,
          ConditionExpression:
            'attribute_not_exists(PK) AND attribute_not_exists(SK)',
        }),
      );
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      const existing = await this.options.client.send(
        new GetCommand({
          TableName: this.options.tableName,
          Key: this.key(input.scope, entityId),
          ConsistentRead: true,
        }),
      );
      if (
        existing.Item?.vectorBinary32LeBase64 !== encoded ||
        existing.Item.dimension !== input.vector.length
      )
        throw new BoundedRetrievalError('INVALID_QUERY_PROFILE');
    }
  }

  public async getQueryVector(input: {
    readonly scope: RetrievalScope;
    readonly queryHash: string;
    readonly embeddingProfileManifestHash: string;
    readonly dimension: number;
  }): Promise<Float32Array> {
    const output = await this.options.client.send(
      new GetCommand({
        TableName: this.options.tableName,
        Key: this.key(
          input.scope,
          this.queryEntity(
            input.scope,
            input.embeddingProfileManifestHash,
            input.queryHash,
          ),
        ),
        ConsistentRead: true,
      }),
    );
    if (
      output.Item === undefined ||
      output.Item.authorizationEpoch !== input.scope.authorizationEpoch ||
      output.Item.dimension !== input.dimension ||
      typeof output.Item.vectorBinary32LeBase64 !== 'string'
    )
      throw new BoundedRetrievalError('INVALID_QUERY_PROFILE');
    const bytes = Buffer.from(output.Item.vectorBinary32LeBase64, 'base64');
    return decodeBinary32Vectors(bytes, 1, input.dimension)[0] as Float32Array;
  }

  public async putAuthorizationHydration(input: {
    readonly scope: RetrievalScope;
    readonly hydration: AuthorizationHydration;
  }): Promise<void> {
    await this.options.client.send(
      new PutCommand({
        TableName: this.options.tableName,
        Item: {
          ...this.key(input.scope, `chunk:${input.hydration.chunkId}`),
          authorizationEpoch: input.scope.authorizationEpoch,
          hydration: input.hydration,
        },
      }),
    );
  }

  private key(scope: RetrievalScope, entityId: string) {
    return retrievalDynamoKeyV1(scope, entityId);
  }

  private stagedEntity(scope: RetrievalScope, mutationId: string): string {
    return `staged-${String(scope.authorizationEpoch)}:${mutationId}`;
  }

  private queryEntity(
    scope: RetrievalScope,
    profileHash: string,
    queryHash: string,
  ): string {
    return `query-${String(scope.authorizationEpoch)}:${profileHash}:${queryHash}`;
  }
}

export function createAwsBoundedRetrievalRuntime(options: {
  readonly dynamo: DynamoDBDocumentClient;
  readonly s3: S3Client;
  readonly tableName: string;
  readonly bucketName: string;
  readonly memory: MemoryProbe;
  readonly encryptionKeyArn?: string;
}) {
  const artifacts = new S3ImmutableRetrievalArtifactStore({
    client: options.s3,
    bucketName: options.bucketName,
    ...(options.encryptionKeyArn === undefined
      ? {}
      : { encryptionKeyArn: options.encryptionKeyArn }),
  });
  const authority = new DynamoS3RetrievalAuthority({
    client: options.dynamo,
    tableName: options.tableName,
  });
  const producer = new DeterministicEffectDisabledEmbedding();
  const index = new BoundedDynamoS3RetrievalIndex({
    authority,
    objects: artifacts,
    memory: options.memory,
  });
  return Object.freeze({
    artifacts,
    authority,
    index,
    producer,
    queryVectors: Object.freeze({
      prepare: (scope: RetrievalScope, queryText: string) =>
        persistEffectDisabledQueryVector({
          store: authority,
          producer,
          scope,
          queryText,
        }),
      prepareInProcess: (queryText: string) =>
        prepareEffectDisabledQueryVector({ producer, queryText }),
    }),
  });
}

export type AwsBoundedRetrievalRuntime = ReturnType<
  typeof createAwsBoundedRetrievalRuntime
>;
