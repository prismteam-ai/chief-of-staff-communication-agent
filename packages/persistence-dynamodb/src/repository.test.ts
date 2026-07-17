import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { KeyedDigestValue } from '@chief/contracts/ids';
import { beforeEach, describe, expect, it } from 'vitest';
import { PersistenceConflictError } from './errors.js';
import { KeyCodec } from './key-codec.js';
import { DynamoPersistence, toEpochMilliseconds } from './repository.js';

const documentMock = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: 'us-east-2',
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
  }),
);
const keys = new KeyCodec({
  current: { version: 'v1', secret: new Uint8Array(32).fill(7) },
});
const persistence = new DynamoPersistence(client, keys);
const artifactHash = 'a'.repeat(64);
const correlationDigest = keys.digest({
  tenantId: 'tenant-a',
  purpose: 'correlation',
  kind: 'provider_subject',
  value: 'provider-correlation-fixture',
});
const providerResponseHash = 'c'.repeat(64);

beforeEach(() => documentMock.reset());

describe('DynamoPersistence', () => {
  it('atomically persists immutable fact plus event outbox and denies duplicates', async () => {
    documentMock.on(TransactWriteCommand).resolves({});
    await persistence.putImmutableFactWithEvent({
      tableName: 'connector',
      tenantId: 'tenant-a',
      accountId: 'account-1',
      fact: {
        factType: 'feedback',
        factId: 'fact-1',
        attributes: { providerEventDigest: correlationDigest },
      },
      eventOutbox: {
        outboxId: 'outbox-1',
        attributes: { status: 'pending' },
      },
    });
    const input = documentMock.commandCall(0, TransactWriteCommand).args[0]
      .input;
    expect(input.TransactItems).toHaveLength(2);
    expect(
      input.TransactItems?.every(
        (item) =>
          item.Put?.ConditionExpression ===
          'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      ),
    ).toBe(true);
  });

  it('denies caller-constructed physical keys before issuing a command', async () => {
    await expect(
      persistence.putImmutableFactWithEvent({
        tableName: 'connector',
        tenantId: 'tenant-a',
        accountId: 'account-1',
        fact: {
          factType: 'feedback',
          factId: 'fact-1',
          attributes: { PK: 'provider-constructed' },
        },
        eventOutbox: {
          outboxId: 'outbox-1',
          attributes: { status: 'pending' },
        },
      }),
    ).rejects.toThrow('must not contain physical keys');
    expect(documentMock.calls()).toHaveLength(0);
  });

  it('writes an immutable revision and CAS-updates the authoritative current head', async () => {
    documentMock.on(TransactWriteCommand).resolves({});
    await persistence.putConditionalRevision({
      tableName: 'core',
      tenantId: 'tenant-a',
      entityType: 'draft',
      entityId: 'draft-1',
      revisionId: 'revision-8',
      expectedVersion: 7,
      expectedRevisionId: 'revision-7',
      nextVersion: 8,
      committedAtEpochMs: 1_721_174_400_000,
      revision: { contentHash: artifactHash },
    });
    const input = documentMock.commandCall(0, TransactWriteCommand).args[0]
      .input;
    expect(input.TransactItems).toHaveLength(2);
    expect(input.TransactItems?.[0]?.Put?.ConditionExpression).toContain(
      'attribute_not_exists',
    );
    const head = input.TransactItems?.[1]?.Update;
    expect(head?.ConditionExpression).toBe(
      '#tenant = :tenant AND #version = :expectedVersion AND #currentRevisionId = :expectedRevisionId',
    );
    expect(head?.ExpressionAttributeValues).toMatchObject({
      ':tenant': 'tenant-a',
      ':expectedVersion': 7,
      ':expectedRevisionId': 'revision-7',
      ':nextVersion': 8,
    });
    expect(JSON.stringify(input)).not.toContain('REV#8"');
  });

  it('translates a stale authoritative-head transaction cancellation', async () => {
    documentMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        $metadata: {},
        message: 'raw revision body must not escape',
      }),
    );
    await expect(
      persistence.putConditionalRevision({
        tableName: 'core',
        tenantId: 'tenant-a',
        entityType: 'draft',
        entityId: 'draft-1',
        revisionId: 'revision-8',
        expectedVersion: 7,
        expectedRevisionId: 'revision-7',
        nextVersion: 8,
        committedAtEpochMs: 1_721_174_400_000,
        revision: { contentHash: artifactHash },
      }),
    ).rejects.toEqual(new PersistenceConflictError());
  });

  it('rejects physical revision keys and non-consecutive revisions before DynamoDB', async () => {
    await expect(
      persistence.putConditionalRevision({
        tableName: 'core',
        tenantId: 'tenant-a',
        entityType: 'draft',
        entityId: 'draft-1',
        revisionId: 'revision-9',
        expectedVersion: 7,
        expectedRevisionId: 'revision-7',
        nextVersion: 9,
        committedAtEpochMs: 1_721_174_400_000,
        revision: { PK: 'provider-built-key' },
      }),
    ).rejects.toThrow(/physical keys|advance by one/u);
    expect(documentMock.calls()).toHaveLength(0);
  });

  it('conditions lease, checkpoint, and approval transitions on every authoritative fence', async () => {
    documentMock.on(UpdateCommand).resolves({});
    await persistence.advanceLease({
      tableName: 'connector',
      tenantId: 'tenant-a',
      accountId: 'account-1',
      leaseId: 'lease-1',
      expectedOwner: 'worker-1',
      expectedLeaseEpoch: 2,
      expectedVersion: 5,
      nextLeaseEpoch: 3,
      nextVersion: 6,
      status: 'active',
      expiresAtEpochMs: 1_721_174_460_000,
    });
    await persistence.advanceCheckpoint({
      tableName: 'connector',
      tenantId: 'tenant-a',
      accountId: 'account-1',
      checkpointId: 'checkpoint-1',
      expectedLeaseEpoch: 3,
      expectedCheckpointEpoch: 9,
      expectedVersion: 12,
      nextCheckpointEpoch: 10,
      nextVersion: 13,
      checkpoint: 'opaque-cursor',
    });
    await persistence.transitionApproval({
      tableName: 'core',
      tenantId: 'tenant-a',
      approvalId: 'approval-1',
      expectedOwner: 'user-1',
      expectedRevision: 4,
      nextRevision: 5,
      expectedStatus: 'approved',
      nextStatus: 'consumed',
    });
    const [lease, checkpoint, approval] = documentMock
      .commandCalls(UpdateCommand)
      .map((call) => call.args[0].input.ConditionExpression);
    expect(lease).toContain('#owner = :owner');
    expect(lease).toContain('#leaseEpoch = :expectedLeaseEpoch');
    expect(lease).toContain('#version = :expectedVersion');
    expect(checkpoint).toContain('#leaseEpoch = :expectedLeaseEpoch');
    expect(checkpoint).toContain('#checkpointEpoch = :expectedCheckpointEpoch');
    expect(checkpoint).toContain('#version = :expectedVersion');
    expect(approval).toContain('#owner = :owner');
    expect(approval).toContain('#revision = :expectedRevision');
    expect(approval).toContain('#status = :expectedStatus');
  });

  it('claims a fresh outbox item only when claimEpoch is absent', async () => {
    documentMock.on(UpdateCommand).resolves({});
    await expect(
      persistence.claimOutbox({
        tableName: 'connector',
        tenantId: 'tenant-a',
        accountId: 'account-1',
        outboxId: 'outbox-1',
        nowEpochMs: 1_721_174_400_000,
        claimOwner: 'worker-1',
        expectedClaimEpoch: 0,
        leaseDurationMs: 60_000,
      }),
    ).resolves.toBe(1);
    const input = documentMock.commandCall(0, UpdateCommand).args[0].input;
    expect(input.ConditionExpression).toBe(
      '#tenant = :tenant AND attribute_not_exists(#claimEpoch) AND (attribute_not_exists(#transport) OR #transport <> :unknown) AND (#status = :ready OR (#status = :retryable AND #nextAttemptAtEpochMs <= :nowEpochMs) OR (#status = :claimed AND #claimExpiresAtEpochMs < :nowEpochMs))',
    );
    expect(input.ExpressionAttributeValues).toEqual({
      ':tenant': 'tenant-a',
      ':ready': 'ready',
      ':retryable': 'retryable',
      ':claimed': 'claimed',
      ':unknown': 'acceptance_unknown',
      ':nextClaimEpoch': 1,
      ':nowEpochMs': 1_721_174_400_000,
      ':claimOwner': 'worker-1',
      ':claimExpiresAtEpochMs': 1_721_174_460_000,
    });
    expect(input.ExpressionAttributeValues).not.toHaveProperty(
      ':expectedClaimEpoch',
    );
    expect(input.ExpressionAttributeValues?.[':unknown']).toBe(
      'acceptance_unknown',
    );
  });

  it('defines exact eligible and ineligible outbox claim branches', () => {
    const nowEpochMs = 1_721_174_400_000;
    const eligible = (item: {
      readonly status: string;
      readonly transportState?: string;
      readonly nextAttemptAtEpochMs?: number;
      readonly claimExpiresAtEpochMs?: number;
    }): boolean => {
      if (item.transportState === 'acceptance_unknown') return false;
      return (
        item.status === 'ready' ||
        (item.status === 'retryable' &&
          item.nextAttemptAtEpochMs !== undefined &&
          item.nextAttemptAtEpochMs <= nowEpochMs) ||
        (item.status === 'claimed' &&
          item.claimExpiresAtEpochMs !== undefined &&
          item.claimExpiresAtEpochMs < nowEpochMs)
      );
    };
    expect(eligible({ status: 'ready' })).toBe(true);
    expect(
      eligible({ status: 'retryable', nextAttemptAtEpochMs: nowEpochMs }),
    ).toBe(true);
    expect(
      eligible({
        status: 'claimed',
        claimExpiresAtEpochMs: nowEpochMs - 1,
      }),
    ).toBe(true);
    expect(
      eligible({
        status: 'retryable',
        nextAttemptAtEpochMs: nowEpochMs + 1,
      }),
    ).toBe(false);
    expect(
      eligible({
        status: 'claimed',
        claimExpiresAtEpochMs: nowEpochMs,
      }),
    ).toBe(false);
    expect(eligible({ status: 'settled' })).toBe(false);
    expect(eligible({ status: 'frozen' })).toBe(false);
    expect(
      eligible({ status: 'ready', transportState: 'acceptance_unknown' }),
    ).toBe(false);
  });

  it('requires exact claimEpoch equality for every subsequent claim', async () => {
    documentMock.on(UpdateCommand).resolves({});
    await expect(
      persistence.claimOutbox({
        tableName: 'connector',
        tenantId: 'tenant-a',
        accountId: 'account-1',
        outboxId: 'outbox-1',
        nowEpochMs: 1_721_174_400_000,
        claimOwner: 'worker-2',
        expectedClaimEpoch: 2,
        leaseDurationMs: 60_000,
      }),
    ).resolves.toBe(3);
    const input = documentMock.commandCall(0, UpdateCommand).args[0].input;
    expect(input.ConditionExpression).toContain(
      '#claimEpoch = :expectedClaimEpoch',
    );
    expect(input.ConditionExpression).not.toContain(
      'attribute_not_exists(#claimEpoch)',
    );
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':expectedClaimEpoch': 2,
      ':nextClaimEpoch': 3,
      ':nowEpochMs': 1_721_174_400_000,
      ':claimExpiresAtEpochMs': 1_721_174_460_000,
    });
  });

  it('fences retry and acceptance-unknown transitions by owner, claim epoch, and attempt', async () => {
    documentMock.on(UpdateCommand).resolves({});
    await persistence.scheduleOutboxRetry({
      tableName: 'connector',
      tenantId: 'tenant-a',
      accountId: 'account-1',
      outboxId: 'outbox-1',
      expectedClaimOwner: 'worker-1',
      expectedClaimEpoch: 3,
      expectedAttemptCount: 2,
      nextAttemptAtEpochMs: 1_721_174_520_000,
    });
    await persistence.freezeAcceptanceUnknown({
      tableName: 'connector',
      tenantId: 'tenant-a',
      accountId: 'account-1',
      outboxId: 'outbox-1',
      expectedClaimOwner: 'worker-1',
      expectedClaimEpoch: 3,
      expectedAttemptCount: 2,
      observedAtEpochMs: 1_721_174_401_000,
    });
    const [retry, freeze] = documentMock
      .commandCalls(UpdateCommand)
      .map((call) => call.args[0].input);
    for (const input of [retry, freeze]) {
      if (input === undefined) throw new Error('Expected update command.');
      expect(input.ConditionExpression).toContain('#claimOwner = :claimOwner');
      expect(input.ConditionExpression).toContain('#claimEpoch = :claimEpoch');
      expect(input.ConditionExpression).toContain(
        '#attemptCount = :expectedAttemptCount',
      );
    }
    expect(retry?.ConditionExpression).toBe(
      '#tenant = :tenant AND #status = :claimed AND #claimOwner = :claimOwner AND #claimEpoch = :claimEpoch AND #attemptCount = :expectedAttemptCount AND #transport = :providerRejected',
    );
    expect(retry?.UpdateExpression).toContain('#status = :retryable');
    expect(retry?.ExpressionAttributeValues?.[':retryable']).toBe('retryable');
    expect(retry?.ExpressionAttributeValues?.[':providerRejected']).toBe(
      'provider_rejected',
    );
    const satisfiesRetryTransportFence = (
      transportState: string | undefined,
    ): boolean =>
      transportState ===
      retry?.ExpressionAttributeValues?.[':providerRejected'];
    expect(satisfiesRetryTransportFence('provider_rejected')).toBe(true);
    expect(satisfiesRetryTransportFence('provider_accepted')).toBe(false);
    expect(satisfiesRetryTransportFence('delivered')).toBe(false);
    expect(satisfiesRetryTransportFence(undefined)).toBe(false);
    expect(freeze?.UpdateExpression).toContain('REMOVE #nextAttemptAtEpochMs');
  });

  it('allows exactly one winner for duplicate effect dispatch CAS', async () => {
    documentMock
      .on(PutCommand)
      .resolvesOnce({})
      .rejectsOnce(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: 'duplicate',
        }),
      );
    const dispatch = {
      tableName: 'connector',
      tenantId: 'tenant-a',
      accountId: 'account-1',
      effectId: 'effect-1',
      artifactRevision: 4,
      artifactHash,
      dispatchOwner: 'worker-1',
      startedAtEpochMs: 1_721_174_400_000,
    } as const;
    await expect(persistence.beginEffectDispatch(dispatch)).resolves.toBe(
      undefined,
    );
    await expect(persistence.beginEffectDispatch(dispatch)).rejects.toEqual(
      new PersistenceConflictError(),
    );
    expect(
      documentMock.commandCall(0, PutCommand).args[0].input.ConditionExpression,
    ).toContain('attribute_not_exists');
  });

  it('persists immutable correlation before allowing provider acceptance', async () => {
    documentMock.on(TransactWriteCommand).resolves({});
    documentMock.on(UpdateCommand).resolves({});
    await persistence.persistEffectCorrelation({
      tableName: 'connector',
      tenantId: 'tenant-a',
      accountId: 'account-1',
      effectId: 'effect-1',
      artifactRevision: 4,
      dispatchOwner: 'worker-1',
      providerCorrelationDigest: correlationDigest,
      providerResponseHash,
      observedAtEpochMs: 1_721_174_401_000,
    });
    await persistence.markEffectProviderAccepted({
      tableName: 'connector',
      tenantId: 'tenant-a',
      accountId: 'account-1',
      effectId: 'effect-1',
      artifactRevision: 4,
      providerCorrelationDigest: correlationDigest,
      observedAtEpochMs: 1_721_174_402_000,
    });
    const correlation = documentMock.commandCall(0, TransactWriteCommand)
      .args[0].input;
    expect(correlation.TransactItems?.[0]?.Put?.Item?.['immutable']).toBe(true);
    expect(
      correlation.TransactItems?.[0]?.Put?.Item?.['providerResponseHash'],
    ).toBe(providerResponseHash);
    expect(correlation.TransactItems?.[1]?.Update?.UpdateExpression).toContain(
      ':correlationPersisted',
    );
    const accepted = documentMock.commandCall(0, UpdateCommand).args[0].input;
    expect(accepted.ConditionExpression).toContain(
      '#state = :correlationPersisted',
    );
    expect(accepted.ConditionExpression).toContain(
      '#correlationDigest = :correlationDigest',
    );
  });

  it('rejects plain content SHA values in keyed correlation fields', async () => {
    await expect(
      persistence.persistEffectCorrelation({
        tableName: 'connector',
        tenantId: 'tenant-a',
        accountId: 'account-1',
        effectId: 'effect-1',
        artifactRevision: 4,
        dispatchOwner: 'worker-1',
        providerCorrelationDigest: 'a'.repeat(64) as KeyedDigestValue,
        providerResponseHash,
        observedAtEpochMs: 1_721_174_401_000,
      }),
    ).rejects.toThrow('Invalid versioned keyed digest.');
    expect(documentMock.calls()).toHaveLength(0);
  });

  it('rejects keyed identity values in provider response content hashes', async () => {
    await expect(
      persistence.persistEffectCorrelation({
        tableName: 'connector',
        tenantId: 'tenant-a',
        accountId: 'account-1',
        effectId: 'effect-1',
        artifactRevision: 4,
        dispatchOwner: 'worker-1',
        providerCorrelationDigest: correlationDigest,
        providerResponseHash: correlationDigest,
        observedAtEpochMs: 1_721_174_401_000,
      }),
    ).rejects.toThrow('providerResponseHash must be');
    expect(documentMock.calls()).toHaveLength(0);
  });

  it('translates correlation transaction cancellation without leaking provider data', async () => {
    const rawProviderId = 'provider-message-secret-123';
    documentMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        $metadata: {},
        message: rawProviderId,
      }),
    );
    const operation = persistence.persistEffectCorrelation({
      tableName: 'connector',
      tenantId: 'tenant-a',
      accountId: 'account-1',
      effectId: 'effect-1',
      artifactRevision: 4,
      dispatchOwner: 'worker-1',
      providerCorrelationDigest: correlationDigest,
      providerResponseHash,
      observedAtEpochMs: 1_721_174_401_000,
    });
    await expect(operation).rejects.toEqual(new PersistenceConflictError());
    expect(
      String(await operation.catch((error: unknown) => error)),
    ).not.toContain(rawProviderId);
  });

  it('freezes uncertain effect acceptance outside retry', async () => {
    documentMock.on(UpdateCommand).resolves({});
    await persistence.freezeEffectAcceptanceUnknown({
      tableName: 'connector',
      tenantId: 'tenant-a',
      accountId: 'account-1',
      effectId: 'effect-1',
      artifactRevision: 4,
      dispatchOwner: 'worker-1',
      observedAtEpochMs: 1_721_174_403_000,
    });
    const input = documentMock.commandCall(0, UpdateCommand).args[0].input;
    expect(input.UpdateExpression).toContain('#state = :unknown');
    expect(input.UpdateExpression).toContain('#reconciliationRequired = :true');
    expect(input.UpdateExpression).toContain('REMOVE #nextAttemptAtEpochMs');
  });

  it('normalizes mixed-offset timestamps to numeric epoch milliseconds', () => {
    expect(toEpochMilliseconds('2026-07-17T02:00:00+02:00')).toBe(
      toEpochMilliseconds('2026-07-17T00:00:00Z'),
    );
    expect(() => toEpochMilliseconds('2026-07-17T00:00:00')).toThrow(
      /explicit offset/u,
    );
  });

  it('executes bounded Query operations and never needs a table scan', async () => {
    documentMock
      .on(QueryCommand)
      .resolves({ Items: [{ PK: 'T#a', SK: 'O#1' }] });
    await expect(
      persistence.queryBounded(
        'connector',
        'OutboxIndex',
        'gsiOutboxPk',
        'STATUS#queued',
        25,
      ),
    ).resolves.toHaveLength(1);
    expect(documentMock.commandCalls(QueryCommand)).toHaveLength(1);
  });
});
