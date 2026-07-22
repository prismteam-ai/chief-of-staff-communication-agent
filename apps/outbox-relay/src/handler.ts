import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  approvalExecutionAuthorityKey,
  approvalExecutionKey,
  approvalExecutionLocatorKey,
} from '@chief/approval-outbox/dynamo-execution-persistence';
import {
  operationIdSchema,
  tenantIdSchema,
  timestampSchema,
  type OperationId,
} from '@chief/contracts/ids';
import { createObservability } from '@chief/observability';
import type {
  AttributeValue,
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';

const SERVICE_NAME = 'chief-outbox-relay';
const MAX_BATCH_SIZE = 10;
const LOCATOR_FIELDS = [
  'PK',
  'SK',
  'aggregatePK',
  'aggregateSK',
  'authorityPK',
  'authoritySK',
  'createdAt',
  'entityType',
  'operationId',
  'schemaVersion',
  'tenantId',
] as const;
const KEY_FIELDS = ['PK', 'SK'] as const;
const observability = createObservability(SERVICE_NAME);

export interface SqsCommandSender {
  send(command: SendMessageCommand): Promise<unknown>;
}

export interface OutboxRelayDependencies {
  readonly queueUrl: string;
  readonly sqs: SqsCommandSender;
}

interface ValidatedLocator {
  readonly operationId: OperationId;
  readonly sequenceNumber: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (
    actual.length !== allowed.length ||
    actual.some((key, index) => key !== allowed[index])
  ) {
    fail(code);
  }
}

function stringAttribute(
  image: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const attribute = image[name];
  if (
    attribute === undefined ||
    typeof attribute !== 'object' ||
    attribute === null
  ) {
    return fail('INVALID_LOCATOR_ATTRIBUTE');
  }
  exactKeys(attribute, ['S'], 'INVALID_LOCATOR_ATTRIBUTE_TYPE');
  if (!('S' in attribute) || typeof attribute.S !== 'string') {
    return fail('INVALID_LOCATOR_ATTRIBUTE_TYPE');
  }
  return attribute.S;
}

function canonicalIdentifier<T>(
  value: string,
  parse: (input: string) => T,
  code: string,
): T {
  try {
    const parsed = parse(value);
    if (parsed !== value) fail(code);
    return parsed;
  } catch {
    return fail(code);
  }
}

function sequenceNumber(record: DynamoDBRecord): string {
  const value = record.dynamodb?.SequenceNumber;
  if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) {
    return fail('INVALID_DYNAMODB_SEQUENCE_NUMBER');
  }
  return value;
}

export function validateLocatorRecord(
  record: DynamoDBRecord,
): ValidatedLocator {
  const sequence = sequenceNumber(record);
  if (record.eventSource !== 'aws:dynamodb' || record.eventName !== 'INSERT') {
    return fail('INVALID_LOCATOR_STREAM_EVENT');
  }
  const stream = record.dynamodb;
  if (
    stream?.StreamViewType !== 'NEW_IMAGE' ||
    stream.Keys === undefined ||
    stream.NewImage === undefined
  ) {
    return fail('INVALID_LOCATOR_STREAM_IMAGE');
  }

  exactKeys(stream.Keys, KEY_FIELDS, 'INVALID_LOCATOR_STREAM_KEYS');
  exactKeys(stream.NewImage, LOCATOR_FIELDS, 'INVALID_LOCATOR_SCHEMA');
  const image = stream.NewImage;
  const keys = stream.Keys;
  const tenantIdValue = stringAttribute(image, 'tenantId');
  const operationIdValue = stringAttribute(image, 'operationId');
  const tenantId = canonicalIdentifier(
    tenantIdValue,
    (input) => tenantIdSchema.parse(input),
    'INVALID_LOCATOR_TENANT',
  );
  const operationId = canonicalIdentifier(
    operationIdValue,
    (input) => operationIdSchema.parse(input),
    'INVALID_LOCATOR_OPERATION',
  );
  const locatorKey = approvalExecutionLocatorKey(operationId);
  const aggregateKey = approvalExecutionKey(tenantId, operationId);
  const authorityKey = approvalExecutionAuthorityKey(tenantId, operationId);

  if (
    stringAttribute(image, 'entityType') !== 'approval_execution_locator' ||
    stringAttribute(image, 'schemaVersion') !== '1' ||
    stringAttribute(image, 'PK') !== locatorKey.PK ||
    stringAttribute(image, 'SK') !== locatorKey.SK ||
    stringAttribute(keys, 'PK') !== locatorKey.PK ||
    stringAttribute(keys, 'SK') !== locatorKey.SK ||
    stringAttribute(image, 'aggregatePK') !== aggregateKey.PK ||
    stringAttribute(image, 'aggregateSK') !== aggregateKey.SK ||
    stringAttribute(image, 'authorityPK') !== authorityKey.PK ||
    stringAttribute(image, 'authoritySK') !== authorityKey.SK
  ) {
    return fail('LOCATOR_AUTHORITY_MISMATCH');
  }
  try {
    timestampSchema.parse(stringAttribute(image, 'createdAt'));
  } catch {
    return fail('INVALID_LOCATOR_CREATED_AT');
  }

  return { operationId, sequenceNumber: sequence };
}

function validateBatch(event: DynamoDBStreamEvent): readonly DynamoDBRecord[] {
  const records: unknown = event?.Records;
  if (
    !Array.isArray(records) ||
    records.length > MAX_BATCH_SIZE ||
    records.some(
      (record) =>
        record === null || typeof record !== 'object' || Array.isArray(record),
    )
  ) {
    return fail('INVALID_OUTBOX_RELAY_BATCH');
  }
  const typedRecords = records as readonly DynamoDBRecord[];
  const sequences = typedRecords.map(sequenceNumber);
  if (new Set(sequences).size !== sequences.length) {
    return fail('DUPLICATE_DYNAMODB_SEQUENCE_NUMBER');
  }
  return typedRecords;
}

export function validateQueueUrl(value: string): string {
  const queueUrl = value.trim();
  try {
    const parsed = new URL(queueUrl);
    if (
      queueUrl !== value ||
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.pathname === '/'
    ) {
      return fail('INVALID_OUTBOX_QUEUE_URL');
    }
    return queueUrl;
  } catch {
    return fail('INVALID_OUTBOX_QUEUE_URL');
  }
}

export function createOutboxRelayHandler(
  dependencies: OutboxRelayDependencies,
): (event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse> {
  const queueUrl = validateQueueUrl(dependencies.queueUrl);
  return async (event) => {
    const records = validateBatch(event);
    const results = await Promise.allSettled(
      records.map(async (record) => {
        const locator = validateLocatorRecord(record);
        await dependencies.sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify({ operationId: locator.operationId }),
          }),
        );
      }),
    );

    return {
      batchItemFailures: results.flatMap((result, index) => {
        if (result.status === 'fulfilled') return [];
        const itemIdentifier = sequenceNumber(records[index] ?? {});
        observability.logger.warn('Outbox locator relay record failed', {
          itemIdentifier,
          reasonCode: 'OUTBOX_LOCATOR_RELAY_FAILED',
        });
        return [{ itemIdentifier }];
      }),
    };
  };
}

function failEveryRecord(
  event: DynamoDBStreamEvent,
): DynamoDBBatchResponse | undefined {
  try {
    return {
      batchItemFailures: validateBatch(event).map((record) => ({
        itemIdentifier: sequenceNumber(record),
      })),
    };
  } catch {
    return undefined;
  }
}

let productionHandler:
  ((event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse>) | undefined;

/**
 * DynamoDB Streams and standard SQS are both at-least-once. Duplicate locator
 * deliveries intentionally enqueue the same operation ID; the execution worker
 * owns the idempotent operation claim and converges those deliveries safely.
 */
export async function handler(
  event: DynamoDBStreamEvent,
): Promise<DynamoDBBatchResponse> {
  try {
    productionHandler ??= createOutboxRelayHandler({
      queueUrl: process.env.OUTBOX_QUEUE_URL ?? '',
      sqs: new SQSClient({}),
    });
    return await productionHandler(event);
  } catch (error) {
    observability.logger.error('Outbox relay invocation failed closed', {
      reasonCode: 'OUTBOX_RELAY_INVOCATION_FAILED',
    });
    const failures = failEveryRecord(event);
    if (failures !== undefined) return failures;
    throw error;
  }
}
