import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoS3RetrievalAuthority, retrievalDynamoKeyV1 } from '@chief/rag';
import type { MemoryProbe } from '@chief/rag';

import { S3ImmutableObjectWriter } from '../aws-composition.js';
import {
  EvaluatorRetrievalSeedError,
  evaluatorRetrievalScope,
  evaluatorRetrievalSeedId,
  seedEvaluatorRetrieval,
} from './retrieval-seed.js';

interface SeedCliConfig {
  readonly tableName: string;
  readonly bucketName: string;
  readonly kmsKeyArn: string;
  readonly region: string;
}

export const evaluatorSeedMemoryLimitBytes = 512 * 1024 * 1024;

export function createEvaluatorSeedMemoryProbe(
  readRssBytes: () => number = () => process.memoryUsage().rss,
): MemoryProbe {
  return {
    sample: () => ({
      rssBytes: readRssBytes(),
      limitBytes: evaluatorSeedMemoryLimitBytes,
    }),
  };
}

const flagToProperty = Object.freeze({
  '--table-name': 'tableName',
  '--bucket-name': 'bucketName',
  '--kms-key-arn': 'kmsKeyArn',
  '--region': 'region',
} as const);

function required(value: string | undefined, code: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0)
    throw new EvaluatorRetrievalSeedError(code);
  if (normalized.length > 2_048)
    throw new EvaluatorRetrievalSeedError('SEED_BINDING_INVALID');
  return normalized;
}

export function parseSeedCliConfig(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): SeedCliConfig {
  const values: Partial<Record<keyof SeedCliConfig, string>> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const property =
      flag === undefined
        ? undefined
        : flagToProperty[flag as keyof typeof flagToProperty];
    const value = argv[index + 1];
    if (property === undefined || value === undefined || value.startsWith('--'))
      throw new EvaluatorRetrievalSeedError('SEED_ARGUMENT_INVALID');
    if (values[property] !== undefined)
      throw new EvaluatorRetrievalSeedError('SEED_ARGUMENT_DUPLICATE');
    values[property] = value;
  }
  return Object.freeze({
    tableName: required(
      values.tableName ?? environment.RETRIEVAL_TABLE_NAME,
      'SEED_RETRIEVAL_TABLE_REQUIRED',
    ),
    bucketName: required(
      values.bucketName ?? environment.SNAPSHOT_BUCKET_NAME,
      'SEED_SNAPSHOT_BUCKET_REQUIRED',
    ),
    kmsKeyArn: required(
      values.kmsKeyArn ?? environment.PRODUCT_DATA_KEY_ARN,
      'SEED_KMS_KEY_REQUIRED',
    ),
    region: required(
      values.region ?? environment.AWS_REGION ?? 'us-east-2',
      'SEED_REGION_REQUIRED',
    ),
  });
}

async function run(): Promise<void> {
  try {
    const config = parseSeedCliConfig(process.argv.slice(2), process.env);
    const dynamo = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: config.region }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
    const authority = new DynamoS3RetrievalAuthority({
      client: dynamo,
      tableName: config.tableName,
    });
    const result = await seedEvaluatorRetrieval({
      artifacts: new S3ImmutableObjectWriter({
        client: new S3Client({ region: config.region }),
        bucketName: config.bucketName,
        encryptionKeyArn: config.kmsKeyArn,
      }),
      authority,
      readAuthorizationEpoch: async () => {
        const output = await dynamo.send(
          new GetCommand({
            TableName: config.tableName,
            Key: retrievalDynamoKeyV1(
              evaluatorRetrievalScope,
              'authorization-epoch',
            ),
            ConsistentRead: true,
          }),
        );
        if (output.Item === undefined) return undefined;
        if (
          output.Item.tenantId !== evaluatorRetrievalScope.tenantId ||
          output.Item.scopeHash !== evaluatorRetrievalScope.scopeHash ||
          output.Item.role !== evaluatorRetrievalScope.role ||
          output.Item.authorizationEpoch !==
            evaluatorRetrievalScope.authorizationEpoch
        )
          throw new EvaluatorRetrievalSeedError(
            'SEED_AUTHORIZATION_EPOCH_DRIFT',
          );
        return evaluatorRetrievalScope.authorizationEpoch;
      },
      memory: createEvaluatorSeedMemoryProbe(),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof EvaluatorRetrievalSeedError
        ? error.code
        : 'SEED_AWS_OPERATION_FAILED';
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: '1',
        seedId: evaluatorRetrievalSeedId,
        status: 'failed',
        code,
      })}\n`,
    );
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
)
  void run();
