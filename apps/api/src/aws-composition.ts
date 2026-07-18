import { createHash } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  createAwsBoundedRetrievalRuntime,
  type AuthorizedRetrievalResult,
  type InProcessQueryVector,
  type MemoryProbe,
} from '@chief/rag';
import {
  deterministicEvaluatorIdentityV2,
  serverRequestContextSchema,
  type RetrievalQuery,
} from '@chief/contracts';

import type { ApiDependencies } from './context.js';
import {
  DynamoDurableProductRepository,
  MemoryDurableProductRepository,
} from './durable-product-repository.js';
import {
  durableEvaluatorAuthority,
  DurableProductService,
  type DurableManifestBinding,
  type DurableRetrievalResult,
  type DurableRetrievalPort,
  type OperationQueue,
} from './durable-product-service.js';

const CLAIMS_HASH =
  '34d276d72d3cd8f6f75364fc1a68f18e380d714b2dc5058d44c3be9b56d57b9b';

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

function memoryProbe(): MemoryProbe {
  return {
    sample: () => {
      const usage = process.memoryUsage();
      const limit = Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? 512);
      return {
        rssBytes: usage.rss,
        limitBytes: Math.max(128, limit) * 1024 * 1024,
      };
    },
  };
}

export function createDurableRequestContext() {
  return serverRequestContextSchema.parse({
    actor: {
      authoritySource: 'verified_identity' as const,
      tenantId: durableEvaluatorAuthority.tenantId,
      userId: durableEvaluatorAuthority.userId,
      accountScopes: durableEvaluatorAuthority.accountIds,
      brandScopes: durableEvaluatorAuthority.brandIds,
      grants: [
        'communications:read',
        'knowledge:read',
        'actions:prepare',
        'actions:approve',
      ],
      membershipVersion: 1,
      verifiedClaimsHash: CLAIMS_HASH,
      verifiedAt: '2026-07-17T12:00:00.000Z',
    },
    retrievalScope: {
      derivation: 'server_grants' as const,
      tenantId: durableEvaluatorAuthority.tenantId,
      accountIds: durableEvaluatorAuthority.accountIds,
      brandIds: durableEvaluatorAuthority.brandIds,
      authorizationEpoch: deterministicEvaluatorIdentityV2.authorizationEpoch,
      scopeHash: deterministicEvaluatorIdentityV2.scopeHash,
    },
  });
}

function createMemoryRetrieval(): DurableRetrievalPort {
  const manifestHash = sha256Text('chief-empty-memory-retrieval.v1');
  return {
    search: () =>
      Promise.resolve({
        candidates: [],
        citations: [],
        snapshotManifestHash: manifestHash,
        evidence: [],
      }),
    verifyManifestBinding: (context, binding, result) =>
      Promise.resolve(
        binding.tenantId === context.retrievalScope?.tenantId &&
          binding.scopeHash === context.retrievalScope.scopeHash &&
          binding.authorizationEpoch ===
            context.retrievalScope.authorizationEpoch &&
          binding.manifestHash === manifestHash &&
          result.snapshotManifestHash === manifestHash &&
          binding.records.length === 0,
      ),
  };
}

interface ReadOnlyAwsRetrievalRuntime {
  readonly queryVectors: {
    prepareInProcess(queryText: string): InProcessQueryVector;
  };
  readonly index: {
    queryWithCitations(
      input: RetrievalQuery,
      inProcessQueryVector: InProcessQueryVector,
    ): Promise<AuthorizedRetrievalResult>;
    inspect(scope: RetrievalQuery['scope']): Promise<{
      readonly status: 'ready';
      readonly authorizationEpoch: number;
      readonly manifestHash: string;
    }>;
  };
}

function canonicalResultRecords(
  result: DurableRetrievalResult,
): DurableManifestBinding['records'] | null {
  if (
    result.candidates.length !== result.citations.length ||
    result.evidence.length !== result.citations.length
  )
    return null;
  const records = result.citations.map((citation) => {
    const candidates = result.candidates.filter(
      (candidate) =>
        candidate.sourceId === citation.sourceId &&
        candidate.chunkId === citation.chunkId &&
        candidate.authorizationEpoch ===
          citation.hydratedUnderAuthorizationEpoch,
    );
    const evidence = result.evidence.filter(
      (item) =>
        item.chunkId === citation.chunkId &&
        item.citationId === citation.citationId,
    );
    if (
      candidates.length !== 1 ||
      evidence.length !== 1 ||
      citation.citationId !==
        `${citation.sourceId}:${citation.chunkId}:${citation.sourceVersion}` ||
      citation.contentHash !==
        sha256Text((evidence[0] as { text: string }).text)
    )
      return null;
    return {
      sourceId: citation.sourceId,
      chunkId: citation.chunkId,
      sourceVersion: citation.sourceVersion,
      authorizationEpoch: citation.hydratedUnderAuthorizationEpoch,
      evidenceHash: citation.contentHash,
    };
  });
  if (
    records.some((record) => record === null) ||
    new Set(records.map((record) => JSON.stringify(record))).size !==
      records.length
  )
    return null;
  return (records as Exclude<(typeof records)[number], null>[]).sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      left.chunkId.localeCompare(right.chunkId) ||
      left.sourceVersion.localeCompare(right.sourceVersion),
  );
}

function retrievalProof(
  result: DurableRetrievalResult,
  records: DurableManifestBinding['records'],
): string {
  const authorized = result as Partial<AuthorizedRetrievalResult>;
  return sha256Text(
    JSON.stringify({
      manifestHash: result.snapshotManifestHash,
      authorizationEpoch: authorized.authorizationEpoch,
      scoringProfileVersion: authorized.scoringProfileVersion,
      records,
      candidates: result.candidates,
      citations: result.citations,
      evidence: result.evidence,
    }),
  );
}

export function createReadOnlyAwsRetrieval(
  runtime: ReadOnlyAwsRetrievalRuntime,
): DurableRetrievalPort {
  const issuedProofs = new WeakMap<object, string>();
  return {
    search: async (context, input) => {
      const serverScope = context.retrievalScope;
      if (serverScope === undefined)
        throw new Error('RETRIEVAL_SCOPE_REQUIRED');
      const scope = { ...serverScope, role: 'factual' as const };
      const prepared = runtime.queryVectors.prepareInProcess(input.queryText);
      const result = await runtime.index.queryWithCitations(
        {
          schemaVersion: '1',
          scope,
          queryText: input.queryText,
          exactEntityRefs: [...input.exactEntityRefs],
          limit: input.limit,
          embeddingProfileManifestHash: prepared.embeddingProfileManifestHash,
          queryHash: prepared.queryHash,
        },
        prepared,
      );
      const records = canonicalResultRecords(result);
      if (records !== null)
        issuedProofs.set(result, retrievalProof(result, records));
      return result;
    },
    verifyManifestBinding: async (context, binding, result) => {
      const serverScope = context.retrievalScope;
      if (serverScope === undefined) return false;
      const scope = { ...serverScope, role: 'factual' as const };
      const records = canonicalResultRecords(result);
      if (records === null) return false;
      const authorized = result as Partial<AuthorizedRetrievalResult>;
      const issuedProof = issuedProofs.get(result);
      if (
        issuedProof === undefined ||
        issuedProof !== retrievalProof(result, records) ||
        binding.contractVersion !== 'chief-validated-manifest-binding.v1' ||
        binding.tenantId !== scope.tenantId ||
        binding.scopeHash !== scope.scopeHash ||
        binding.authorizationEpoch !== scope.authorizationEpoch ||
        binding.role !== scope.role ||
        binding.manifestHash !== result.snapshotManifestHash ||
        binding.scoringProfileVersion !== 'chief-bounded-fusion-v1' ||
        authorized.authorizationEpoch !== binding.authorizationEpoch ||
        authorized.scoringProfileVersion !== binding.scoringProfileVersion ||
        records.some(
          (record) => record.authorizationEpoch !== binding.authorizationEpoch,
        ) ||
        JSON.stringify(binding.records) !== JSON.stringify(records)
      )
        return false;
      try {
        const active = await runtime.index.inspect(scope);
        return (
          active.status === 'ready' &&
          active.authorizationEpoch === binding.authorizationEpoch &&
          active.manifestHash === binding.manifestHash
        );
      } catch {
        return false;
      }
    },
  };
}

export function createMemoryDurableApiDependencies(input?: {
  readonly repository?: MemoryDurableProductRepository;
  readonly now?: () => string;
  readonly baseUrl?: string;
  readonly operationQueue?: OperationQueue;
}): ApiDependencies {
  const repository = input?.repository ?? new MemoryDurableProductRepository();
  return {
    productService: new DurableProductService(
      repository,
      createMemoryRetrieval(),
      input?.baseUrl ?? 'https://chief.example.test',
      input?.now,
      input?.operationQueue,
    ),
    requestContext: createDurableRequestContext(),
  };
}

export function createAwsDurableApiDependencies(
  environment: Readonly<Record<string, string | undefined>>,
): ApiDependencies {
  const coreTableName = required(environment, 'CORE_TABLE_NAME');
  const retrievalTableName = required(environment, 'RETRIEVAL_TABLE_NAME');
  const snapshotBucketName = required(environment, 'SNAPSHOT_BUCKET_NAME');
  const baseUrl = required(environment, 'PRODUCT_BASE_URL');
  const outboxQueueUrl = environment.OUTBOX_QUEUE_URL?.trim();
  const dynamo = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: environment.AWS_REGION ?? 'us-east-2' }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  const s3 = new S3Client({ region: environment.AWS_REGION ?? 'us-east-2' });
  const operationQueue: OperationQueue | undefined =
    outboxQueueUrl === undefined || outboxQueueUrl === ''
      ? undefined
      : {
          enqueue: async (operationId) => {
            await new SQSClient({
              region: environment.AWS_REGION ?? 'us-east-2',
            }).send(
              new SendMessageCommand({
                QueueUrl: outboxQueueUrl,
                MessageBody: JSON.stringify({ operationId }),
              }),
            );
          },
        };
  const runtime = createAwsBoundedRetrievalRuntime({
    dynamo,
    s3,
    tableName: retrievalTableName,
    bucketName: snapshotBucketName,
    memory: memoryProbe(),
  });
  const retrieval = createReadOnlyAwsRetrieval(runtime);
  return {
    productService: new DurableProductService(
      new DynamoDurableProductRepository(dynamo, coreTableName),
      retrieval,
      baseUrl,
      undefined,
      operationQueue,
    ),
    requestContext: createDurableRequestContext(),
  };
}

export function createDefaultDurableApiDependencies(): ApiDependencies {
  return process.env.NODE_ENV === 'test'
    ? createMemoryDurableApiDependencies()
    : createAwsDurableApiDependencies(process.env);
}
