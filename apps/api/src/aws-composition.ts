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
  citationSchema,
  deterministicEvaluatorIdentityV2,
  retrievalCandidateSchema,
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
  return {
    search: (context, input) => {
      const authorizationEpoch =
        context.retrievalScope?.authorizationEpoch ?? 1;
      const values = [
        {
          chunkId: 'chunk-communication-1',
          sourceId: 'source-communication-1',
          label: 'Friday launch decision',
          text: 'The Friday launch decision is pending confirmation of the QA owner.',
        },
        {
          chunkId: 'chunk-asana-1',
          sourceId: 'source-asana-1',
          label: 'Launch readiness task SEC-4821',
          text: 'Launch readiness task SEC-4821 tracks the QA owner commitment.',
        },
      ].slice(0, input.limit);
      const citations = values.map((value) =>
        citationSchema.parse({
          citationId: `${value.sourceId}:${value.chunkId}:1`,
          sourceId: value.sourceId,
          sourceVersion: '1',
          chunkId: value.chunkId,
          label: value.label,
          contentHash: sha256Text(value.text),
          hydratedUnderAuthorizationEpoch: authorizationEpoch,
        }),
      );
      return Promise.resolve({
        candidates: values.map((value, index) =>
          retrievalCandidateSchema.parse({
            chunkId: value.chunkId,
            sourceId: value.sourceId,
            lexicalScore: 1 - index * 0.1,
            vectorScore: 0.9 - index * 0.1,
            fusedScore: 0.95 - index * 0.1,
            authorizationEpoch,
          }),
        ),
        citations,
        snapshotManifestHash: sha256Text(JSON.stringify(values)),
        evidence: values.map((value, index) => ({
          chunkId: value.chunkId,
          citationId: citations[index]?.citationId as string,
          text: value.text,
        })),
      });
    },
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
  };
}

export function createReadOnlyAwsRetrieval(
  runtime: ReadOnlyAwsRetrievalRuntime,
): DurableRetrievalPort {
  return {
    search: async (context, input) => {
      const serverScope = context.retrievalScope;
      if (serverScope === undefined)
        throw new Error('RETRIEVAL_SCOPE_REQUIRED');
      const scope = { ...serverScope, role: 'factual' as const };
      const prepared = runtime.queryVectors.prepareInProcess(input.queryText);
      return runtime.index.queryWithCitations(
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
