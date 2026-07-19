import type { SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  approvalExecutionAuthorityKey,
  approvalExecutionKey,
  approvalExecutionLocatorKey,
} from '@chief/approval-outbox/dynamo-execution-persistence';
import type {
  AttributeValue,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import {
  createOutboxRelayHandler,
  validateLocatorRecord,
  validateQueueUrl,
  type SqsCommandSender,
} from './handler.js';

const QUEUE_URL =
  'https://sqs.us-east-2.amazonaws.com/417242953053/chief-outbox';
const CREATED_AT = '2026-07-19T10:00:00.000Z';

function stringAttribute(value: string): AttributeValue {
  return { S: value };
}

function locatorRecord(input?: {
  readonly operationId?: string;
  readonly sequenceNumber?: string;
  readonly tenantId?: string;
}): DynamoDBRecord {
  const operationId = input?.operationId ?? 'operation-send-001';
  const tenantId = input?.tenantId ?? 'tenant-evaluator';
  const locator = approvalExecutionLocatorKey(operationId);
  const aggregate = approvalExecutionKey(tenantId, operationId);
  const authority = approvalExecutionAuthorityKey(tenantId, operationId);
  const image: Record<string, AttributeValue> = {
    PK: stringAttribute(locator.PK),
    SK: stringAttribute(locator.SK),
    aggregatePK: stringAttribute(aggregate.PK),
    aggregateSK: stringAttribute(aggregate.SK),
    authorityPK: stringAttribute(authority.PK),
    authoritySK: stringAttribute(authority.SK),
    createdAt: stringAttribute(CREATED_AT),
    entityType: stringAttribute('approval_execution_locator'),
    operationId: stringAttribute(operationId),
    schemaVersion: stringAttribute('1'),
    tenantId: stringAttribute(tenantId),
  };
  return {
    eventID: `event-${input?.sequenceNumber ?? '101'}`,
    eventName: 'INSERT',
    eventSource: 'aws:dynamodb',
    eventVersion: '1.1',
    dynamodb: {
      Keys: { PK: image.PK!, SK: image.SK! },
      NewImage: image,
      SequenceNumber: input?.sequenceNumber ?? '101',
      StreamViewType: 'NEW_IMAGE',
    },
  };
}

function event(...records: DynamoDBRecord[]): DynamoDBStreamEvent {
  return { Records: records };
}

function recordingSender(input?: {
  readonly rejectOperationId?: string;
}): SqsCommandSender & { readonly commands: SendMessageCommand[] } {
  const commands: SendMessageCommand[] = [];
  return {
    commands,
    send: (command) => {
      commands.push(command);
      if (
        command.input.MessageBody ===
        JSON.stringify({ operationId: input?.rejectOperationId })
      ) {
        return Promise.reject(new Error('SQS_UNAVAILABLE'));
      }
      return Promise.resolve({});
    },
  };
}

describe('outbox locator relay', () => {
  it('sends only the validated operation ID', async () => {
    const sqs = recordingSender();
    const relay = createOutboxRelayHandler({ queueUrl: QUEUE_URL, sqs });

    await expect(relay(event(locatorRecord()))).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(sqs.commands).toHaveLength(1);
    expect(sqs.commands[0]?.input).toEqual({
      QueueUrl: QUEUE_URL,
      MessageBody: '{"operationId":"operation-send-001"}',
    });
  });

  it('preserves partial-batch failures for malformed records and failed sends', async () => {
    const sqs = recordingSender({ rejectOperationId: 'operation-send-002' });
    const relay = createOutboxRelayHandler({ queueUrl: QUEUE_URL, sqs });
    const malformed = locatorRecord({
      operationId: 'operation-send-003',
      sequenceNumber: '103',
    });
    if (malformed.dynamodb?.NewImage === undefined)
      throw new Error('EXPECTED_IMAGE');
    malformed.dynamodb.NewImage.schemaVersion = stringAttribute('2');

    await expect(
      relay(
        event(
          locatorRecord({ sequenceNumber: '101' }),
          locatorRecord({
            operationId: 'operation-send-002',
            sequenceNumber: '102',
          }),
          malformed,
        ),
      ),
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: '102' }, { itemIdentifier: '103' }],
    });
    expect(sqs.commands.map(({ input }) => input.MessageBody)).toEqual([
      '{"operationId":"operation-send-001"}',
      '{"operationId":"operation-send-002"}',
    ]);
  });

  it('fails closed on schema, key, tenant, operation, and event drift', () => {
    const cases: Array<readonly [string, (record: DynamoDBRecord) => void]> = [
      [
        'unknown schema fields',
        (record) => {
          if (record.dynamodb?.NewImage === undefined)
            throw new Error('EXPECTED_IMAGE');
          record.dynamodb.NewImage.untrusted = stringAttribute('value');
        },
      ],
      [
        'locator key mismatch',
        (record) => {
          if (record.dynamodb?.Keys === undefined)
            throw new Error('EXPECTED_KEYS');
          record.dynamodb.Keys.PK = stringAttribute('O#foreign');
        },
      ],
      [
        'tenant route mismatch',
        (record) => {
          if (record.dynamodb?.NewImage === undefined)
            throw new Error('EXPECTED_IMAGE');
          record.dynamodb.NewImage.aggregatePK = stringAttribute('T#foreign');
        },
      ],
      [
        'non-canonical tenant',
        (record) => {
          if (record.dynamodb?.NewImage === undefined)
            throw new Error('EXPECTED_IMAGE');
          record.dynamodb.NewImage.tenantId =
            stringAttribute(' tenant-evaluator');
        },
      ],
      [
        'operation route mismatch',
        (record) => {
          if (record.dynamodb?.NewImage === undefined)
            throw new Error('EXPECTED_IMAGE');
          record.dynamodb.NewImage.aggregateSK = stringAttribute('E#foreign');
        },
      ],
      [
        'operation identity mismatch',
        (record) => {
          if (record.dynamodb?.NewImage === undefined)
            throw new Error('EXPECTED_IMAGE');
          record.dynamodb.NewImage.operationId = stringAttribute(
            'operation-send-foreign',
          );
        },
      ],
      [
        'non-insert event',
        (record) => {
          record.eventName = 'MODIFY';
        },
      ],
    ];

    for (const [, mutate] of cases) {
      const record = locatorRecord();
      mutate(record);
      expect(() => validateLocatorRecord(record)).toThrow();
    }
  });

  it('forwards duplicate locator deliveries unchanged for idempotent execution', async () => {
    const sqs = recordingSender();
    const relay = createOutboxRelayHandler({ queueUrl: QUEUE_URL, sqs });

    await expect(
      relay(
        event(
          locatorRecord({ sequenceNumber: '201' }),
          locatorRecord({ sequenceNumber: '202' }),
        ),
      ),
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(sqs.commands.map(({ input }) => input.MessageBody)).toEqual([
      '{"operationId":"operation-send-001"}',
      '{"operationId":"operation-send-001"}',
    ]);
  });

  it('requires a canonical HTTPS queue URL', () => {
    expect(validateQueueUrl(QUEUE_URL)).toBe(QUEUE_URL);
    for (const value of [
      '',
      ` ${QUEUE_URL}`,
      'http://localhost:4566/queue',
      `${QUEUE_URL}?authority=extra`,
    ]) {
      expect(() => validateQueueUrl(value)).toThrow('INVALID_OUTBOX_QUEUE_URL');
    }
  });
});
