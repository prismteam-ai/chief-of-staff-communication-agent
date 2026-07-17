import {
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  keyedDigestValueSchema,
  sha256Schema,
  type KeyedDigestValue,
} from '@chief/contracts/ids';

import { translatePersistenceError } from './errors.js';
import type { KeyCodec } from './key-codec.js';

export interface PersistenceTables {
  readonly core: string;
  readonly connectorRuntime: string;
  readonly retrieval: string;
}

export interface TenantFactWrite {
  readonly tableName: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly fact: {
    readonly factType: string;
    readonly factId: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  };
  readonly eventOutbox: {
    readonly outboxId: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  };
}

export interface ConditionalRevisionWrite {
  readonly tableName: string;
  readonly tenantId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly revisionId: string;
  readonly expectedVersion?: number;
  readonly expectedRevisionId?: string;
  readonly nextVersion: number;
  readonly committedAtEpochMs: number;
  readonly revision: Readonly<Record<string, unknown>>;
}

export interface LeaseTransitionInput {
  readonly tableName: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly leaseId: string;
  readonly expectedOwner: string;
  readonly expectedLeaseEpoch: number;
  readonly expectedVersion: number;
  readonly nextLeaseEpoch: number;
  readonly nextVersion: number;
  readonly status: string;
  readonly expiresAtEpochMs: number;
}

export interface CheckpointTransitionInput {
  readonly tableName: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly checkpointId: string;
  readonly expectedLeaseEpoch: number;
  readonly expectedCheckpointEpoch: number;
  readonly expectedVersion: number;
  readonly nextCheckpointEpoch: number;
  readonly nextVersion: number;
  readonly checkpoint: unknown;
}

export interface ApprovalTransitionInput {
  readonly tableName: string;
  readonly tenantId: string;
  readonly approvalId: string;
  readonly expectedOwner: string;
  readonly expectedRevision: number;
  readonly nextRevision: number;
  readonly expectedStatus: string;
  readonly nextStatus: string;
}

export interface OutboxClaimInput {
  readonly tableName: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly outboxId: string;
  readonly nowEpochMs: number;
  readonly claimOwner: string;
  readonly expectedClaimEpoch: number;
  readonly leaseDurationMs: number;
}

export interface OutboxRetryInput {
  readonly tableName: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly outboxId: string;
  readonly expectedClaimOwner: string;
  readonly expectedClaimEpoch: number;
  readonly expectedAttemptCount: number;
  readonly nextAttemptAtEpochMs: number;
}

export interface AcceptanceUnknownInput {
  readonly tableName: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly outboxId: string;
  readonly expectedClaimOwner: string;
  readonly expectedClaimEpoch: number;
  readonly expectedAttemptCount: number;
  readonly observedAtEpochMs: number;
}

export interface EffectDispatchInput {
  readonly tableName: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly effectId: string;
  readonly artifactRevision: number;
  readonly artifactHash: string;
  readonly dispatchOwner: string;
  readonly startedAtEpochMs: number;
}

export interface EffectCorrelationInput {
  readonly tableName: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly effectId: string;
  readonly artifactRevision: number;
  readonly dispatchOwner: string;
  readonly providerCorrelationDigest: KeyedDigestValue;
  readonly providerResponseHash: string;
  readonly observedAtEpochMs: number;
}

export interface EffectAcceptanceInput {
  readonly tableName: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly effectId: string;
  readonly artifactRevision: number;
  readonly providerCorrelationDigest: KeyedDigestValue;
  readonly observedAtEpochMs: number;
}

export interface EffectAcceptanceUnknownInput {
  readonly tableName: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly effectId: string;
  readonly artifactRevision: number;
  readonly dispatchOwner: string;
  readonly observedAtEpochMs: number;
}

const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

function assertEpochMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative epoch millisecond value.`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer.`);
}

function assertNext(current: number, next: number, name: string): void {
  assertPositiveInteger(next, name);
  if (next !== current + 1) throw new Error(`${name} must advance by one.`);
}

function assertKeyedDigest(value: string): asserts value is KeyedDigestValue {
  if (!keyedDigestValueSchema.safeParse(value).success)
    throw new Error('Invalid versioned keyed digest.');
}

function assertSha256(value: string, name: string): void {
  if (!sha256Schema.safeParse(value).success)
    throw new Error(`${name} must be a lowercase SHA-256 content hash.`);
}

function assertNoPhysicalKeys(value: Readonly<Record<string, unknown>>): void {
  if ('PK' in value || 'SK' in value)
    throw new Error('Revision input must not contain physical keys.');
}

export function toEpochMilliseconds(timestamp: string): number {
  if (!ISO_WITH_OFFSET.test(timestamp))
    throw new Error('Timestamp must be ISO-8601 with an explicit offset.');
  const epochMs = Date.parse(timestamp);
  assertEpochMs(epochMs, 'timestamp');
  return epochMs;
}

export class DynamoPersistence {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly keys: KeyCodec,
  ) {}

  public async putImmutableFactWithEvent(
    input: TenantFactWrite,
  ): Promise<void> {
    assertNoPhysicalKeys(input.fact.attributes);
    assertNoPhysicalKeys(input.eventOutbox.attributes);
    const factKey = this.keys.connectorEntity(
      input.tenantId,
      input.accountId,
      'fact',
      `${input.fact.factType}:${input.fact.factId}`,
    );
    const outboxKey = this.keys.connectorEntity(
      input.tenantId,
      input.accountId,
      'event-outbox',
      input.eventOutbox.outboxId,
    );
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: input.tableName,
                Item: {
                  ...input.fact.attributes,
                  ...factKey,
                  tenantId: input.tenantId,
                  accountId: input.accountId,
                  factType: input.fact.factType,
                  factId: input.fact.factId,
                  immutable: true,
                },
                ConditionExpression:
                  'attribute_not_exists(PK) AND attribute_not_exists(SK)',
              },
            },
            {
              Put: {
                TableName: input.tableName,
                Item: {
                  ...input.eventOutbox.attributes,
                  ...outboxKey,
                  tenantId: input.tenantId,
                  accountId: input.accountId,
                  outboxId: input.eventOutbox.outboxId,
                },
                ConditionExpression:
                  'attribute_not_exists(PK) AND attribute_not_exists(SK)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      translatePersistenceError(error);
    }
  }

  public async putConditionalRevision(
    input: ConditionalRevisionWrite,
  ): Promise<void> {
    assertEpochMs(input.committedAtEpochMs, 'committedAtEpochMs');
    assertNoPhysicalKeys(input.revision);
    const create = input.expectedVersion === undefined;
    if (create) {
      if (input.expectedRevisionId !== undefined || input.nextVersion !== 1)
        throw new Error('Initial revision must create version one.');
    } else {
      assertPositiveInteger(input.expectedVersion, 'expectedVersion');
      if (input.expectedRevisionId === undefined)
        throw new Error('Expected revision id is required for head CAS.');
      assertNext(input.expectedVersion, input.nextVersion, 'nextVersion');
    }
    const headKey = this.keys.coreEntity(
      input.tenantId,
      input.entityType,
      input.entityId,
    );
    const revisionKey = this.keys.coreRevision(
      input.tenantId,
      input.entityType,
      input.entityId,
      input.nextVersion,
      input.revisionId,
    );
    const revisionItem = {
      ...input.revision,
      ...revisionKey,
      tenantId: input.tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
      revisionId: input.revisionId,
      version: input.nextVersion,
      committedAtEpochMs: input.committedAtEpochMs,
      immutable: true,
    };
    const headValues: Record<string, unknown> = {
      ':tenant': input.tenantId,
      ':nextVersion': input.nextVersion,
      ':revisionId': input.revisionId,
      ':revisionSk': revisionKey.SK,
      ':committedAtEpochMs': input.committedAtEpochMs,
    };
    if (!create) {
      headValues[':expectedVersion'] = input.expectedVersion;
      headValues[':expectedRevisionId'] = input.expectedRevisionId;
    }
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: input.tableName,
                Item: revisionItem,
                ConditionExpression:
                  'attribute_not_exists(PK) AND attribute_not_exists(SK)',
              },
            },
            create
              ? {
                  Put: {
                    TableName: input.tableName,
                    Item: {
                      ...headKey,
                      tenantId: input.tenantId,
                      entityType: input.entityType,
                      entityId: input.entityId,
                      version: input.nextVersion,
                      currentRevisionId: input.revisionId,
                      currentRevisionSk: revisionKey.SK,
                      updatedAtEpochMs: input.committedAtEpochMs,
                    },
                    ConditionExpression:
                      'attribute_not_exists(PK) AND attribute_not_exists(SK)',
                  },
                }
              : {
                  Update: {
                    TableName: input.tableName,
                    Key: headKey,
                    ConditionExpression:
                      '#tenant = :tenant AND #version = :expectedVersion AND #currentRevisionId = :expectedRevisionId',
                    UpdateExpression:
                      'SET #version = :nextVersion, #currentRevisionId = :revisionId, #currentRevisionSk = :revisionSk, #updatedAtEpochMs = :committedAtEpochMs',
                    ExpressionAttributeNames: {
                      '#tenant': 'tenantId',
                      '#version': 'version',
                      '#currentRevisionId': 'currentRevisionId',
                      '#currentRevisionSk': 'currentRevisionSk',
                      '#updatedAtEpochMs': 'updatedAtEpochMs',
                    },
                    ExpressionAttributeValues: headValues,
                  },
                },
          ],
        }),
      );
    } catch (error) {
      translatePersistenceError(error);
    }
  }

  public async advanceLease(input: LeaseTransitionInput): Promise<void> {
    assertNext(
      input.expectedLeaseEpoch,
      input.nextLeaseEpoch,
      'nextLeaseEpoch',
    );
    assertNext(input.expectedVersion, input.nextVersion, 'nextVersion');
    assertEpochMs(input.expiresAtEpochMs, 'expiresAtEpochMs');
    await this.updateWithConflictTranslation({
      TableName: input.tableName,
      Key: this.keys.connectorEntity(
        input.tenantId,
        input.accountId,
        'lease',
        input.leaseId,
      ),
      ConditionExpression:
        '#tenant = :tenant AND #owner = :owner AND #leaseEpoch = :expectedLeaseEpoch AND #version = :expectedVersion',
      UpdateExpression:
        'SET #leaseEpoch = :nextLeaseEpoch, #version = :nextVersion, #status = :status, #expiresAtEpochMs = :expiresAtEpochMs',
      ExpressionAttributeNames: {
        '#tenant': 'tenantId',
        '#owner': 'owner',
        '#leaseEpoch': 'leaseEpoch',
        '#version': 'version',
        '#status': 'status',
        '#expiresAtEpochMs': 'expiresAtEpochMs',
      },
      ExpressionAttributeValues: {
        ':tenant': input.tenantId,
        ':owner': input.expectedOwner,
        ':expectedLeaseEpoch': input.expectedLeaseEpoch,
        ':expectedVersion': input.expectedVersion,
        ':nextLeaseEpoch': input.nextLeaseEpoch,
        ':nextVersion': input.nextVersion,
        ':status': input.status,
        ':expiresAtEpochMs': input.expiresAtEpochMs,
      },
    });
  }

  public async advanceCheckpoint(
    input: CheckpointTransitionInput,
  ): Promise<void> {
    assertNext(
      input.expectedCheckpointEpoch,
      input.nextCheckpointEpoch,
      'nextCheckpointEpoch',
    );
    assertNext(input.expectedVersion, input.nextVersion, 'nextVersion');
    await this.updateWithConflictTranslation({
      TableName: input.tableName,
      Key: this.keys.connectorEntity(
        input.tenantId,
        input.accountId,
        'checkpoint',
        input.checkpointId,
      ),
      ConditionExpression:
        '#tenant = :tenant AND #leaseEpoch = :expectedLeaseEpoch AND #checkpointEpoch = :expectedCheckpointEpoch AND #version = :expectedVersion',
      UpdateExpression:
        'SET #checkpointEpoch = :nextCheckpointEpoch, #version = :nextVersion, #checkpoint = :checkpoint',
      ExpressionAttributeNames: {
        '#tenant': 'tenantId',
        '#leaseEpoch': 'leaseEpoch',
        '#checkpointEpoch': 'checkpointEpoch',
        '#version': 'version',
        '#checkpoint': 'checkpoint',
      },
      ExpressionAttributeValues: {
        ':tenant': input.tenantId,
        ':expectedLeaseEpoch': input.expectedLeaseEpoch,
        ':expectedCheckpointEpoch': input.expectedCheckpointEpoch,
        ':expectedVersion': input.expectedVersion,
        ':nextCheckpointEpoch': input.nextCheckpointEpoch,
        ':nextVersion': input.nextVersion,
        ':checkpoint': input.checkpoint,
      },
    });
  }

  public async transitionApproval(
    input: ApprovalTransitionInput,
  ): Promise<void> {
    assertNext(input.expectedRevision, input.nextRevision, 'nextRevision');
    await this.updateWithConflictTranslation({
      TableName: input.tableName,
      Key: this.keys.coreEntity(input.tenantId, 'approval', input.approvalId),
      ConditionExpression:
        '#tenant = :tenant AND #owner = :owner AND #revision = :expectedRevision AND #status = :expectedStatus',
      UpdateExpression: 'SET #revision = :nextRevision, #status = :nextStatus',
      ExpressionAttributeNames: {
        '#tenant': 'tenantId',
        '#owner': 'owner',
        '#revision': 'revision',
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':tenant': input.tenantId,
        ':owner': input.expectedOwner,
        ':expectedRevision': input.expectedRevision,
        ':expectedStatus': input.expectedStatus,
        ':nextRevision': input.nextRevision,
        ':nextStatus': input.nextStatus,
      },
    });
  }

  public async claimOutbox(input: OutboxClaimInput): Promise<number> {
    assertEpochMs(input.nowEpochMs, 'nowEpochMs');
    assertPositiveInteger(input.leaseDurationMs, 'leaseDurationMs');
    if (
      !Number.isSafeInteger(input.expectedClaimEpoch) ||
      input.expectedClaimEpoch < 0
    )
      throw new Error('expectedClaimEpoch must be a non-negative integer.');
    const nextClaimEpoch = input.expectedClaimEpoch + 1;
    const claimExpiresAtEpochMs = input.nowEpochMs + input.leaseDurationMs;
    assertEpochMs(claimExpiresAtEpochMs, 'claimExpiresAtEpochMs');
    const claimEpochCondition =
      input.expectedClaimEpoch === 0
        ? 'attribute_not_exists(#claimEpoch)'
        : '#claimEpoch = :expectedClaimEpoch';
    const claimValues: Record<string, unknown> = {
      ':tenant': input.tenantId,
      ':ready': 'ready',
      ':retryable': 'retryable',
      ':claimed': 'claimed',
      ':unknown': 'acceptance_unknown',
      ':nextClaimEpoch': nextClaimEpoch,
      ':nowEpochMs': input.nowEpochMs,
      ':claimOwner': input.claimOwner,
      ':claimExpiresAtEpochMs': claimExpiresAtEpochMs,
    };
    if (input.expectedClaimEpoch > 0)
      claimValues[':expectedClaimEpoch'] = input.expectedClaimEpoch;
    await this.updateWithConflictTranslation({
      TableName: input.tableName,
      Key: this.outboxKey(input),
      ConditionExpression: `#tenant = :tenant AND ${claimEpochCondition} AND (attribute_not_exists(#transport) OR #transport <> :unknown) AND (#status = :ready OR (#status = :retryable AND #nextAttemptAtEpochMs <= :nowEpochMs) OR (#status = :claimed AND #claimExpiresAtEpochMs < :nowEpochMs))`,
      UpdateExpression:
        'SET #status = :claimed, #claimOwner = :claimOwner, #claimEpoch = :nextClaimEpoch, #claimExpiresAtEpochMs = :claimExpiresAtEpochMs',
      ExpressionAttributeNames: {
        '#tenant': 'tenantId',
        '#status': 'status',
        '#transport': 'transportState',
        '#claimOwner': 'claimOwner',
        '#claimEpoch': 'claimEpoch',
        '#claimExpiresAtEpochMs': 'claimExpiresAtEpochMs',
        '#nextAttemptAtEpochMs': 'nextAttemptAtEpochMs',
      },
      ExpressionAttributeValues: claimValues,
    });
    return nextClaimEpoch;
  }

  public async scheduleOutboxRetry(input: OutboxRetryInput): Promise<void> {
    assertEpochMs(input.nextAttemptAtEpochMs, 'nextAttemptAtEpochMs');
    assertPositiveInteger(input.expectedClaimEpoch, 'expectedClaimEpoch');
    if (
      !Number.isSafeInteger(input.expectedAttemptCount) ||
      input.expectedAttemptCount < 0
    )
      throw new Error('expectedAttemptCount must be a non-negative integer.');
    await this.updateWithConflictTranslation({
      TableName: input.tableName,
      Key: this.outboxKey(input),
      ConditionExpression:
        '#tenant = :tenant AND #status = :claimed AND #claimOwner = :claimOwner AND #claimEpoch = :claimEpoch AND #attemptCount = :expectedAttemptCount AND #transport = :providerRejected',
      UpdateExpression:
        'SET #status = :retryable, #attemptCount = :nextAttemptCount, #nextAttemptAtEpochMs = :nextAttemptAtEpochMs REMOVE #claimOwner, #claimExpiresAtEpochMs',
      ExpressionAttributeNames: {
        '#tenant': 'tenantId',
        '#status': 'status',
        '#claimOwner': 'claimOwner',
        '#claimEpoch': 'claimEpoch',
        '#claimExpiresAtEpochMs': 'claimExpiresAtEpochMs',
        '#attemptCount': 'attemptCount',
        '#transport': 'transportState',
        '#nextAttemptAtEpochMs': 'nextAttemptAtEpochMs',
      },
      ExpressionAttributeValues: {
        ':tenant': input.tenantId,
        ':claimed': 'claimed',
        ':retryable': 'retryable',
        ':claimOwner': input.expectedClaimOwner,
        ':claimEpoch': input.expectedClaimEpoch,
        ':expectedAttemptCount': input.expectedAttemptCount,
        ':nextAttemptCount': input.expectedAttemptCount + 1,
        ':providerRejected': 'provider_rejected',
        ':nextAttemptAtEpochMs': input.nextAttemptAtEpochMs,
      },
    });
  }

  public async freezeAcceptanceUnknown(
    input: AcceptanceUnknownInput,
  ): Promise<void> {
    assertEpochMs(input.observedAtEpochMs, 'observedAtEpochMs');
    await this.updateWithConflictTranslation({
      TableName: input.tableName,
      Key: this.outboxKey(input),
      ConditionExpression:
        '#tenant = :tenant AND #status = :claimed AND #claimOwner = :claimOwner AND #claimEpoch = :claimEpoch AND #attemptCount = :expectedAttemptCount AND attribute_not_exists(#acceptanceFrozenAtEpochMs)',
      UpdateExpression:
        'SET #status = :reconcile, #transport = :unknown, #acceptanceFrozenAtEpochMs = :observedAtEpochMs REMOVE #nextAttemptAtEpochMs, #claimOwner, #claimExpiresAtEpochMs',
      ExpressionAttributeNames: {
        '#tenant': 'tenantId',
        '#status': 'status',
        '#transport': 'transportState',
        '#claimOwner': 'claimOwner',
        '#claimEpoch': 'claimEpoch',
        '#claimExpiresAtEpochMs': 'claimExpiresAtEpochMs',
        '#attemptCount': 'attemptCount',
        '#acceptanceFrozenAtEpochMs': 'acceptanceFrozenAtEpochMs',
        '#nextAttemptAtEpochMs': 'nextAttemptAtEpochMs',
      },
      ExpressionAttributeValues: {
        ':tenant': input.tenantId,
        ':claimed': 'claimed',
        ':reconcile': 'reconciliation_required',
        ':unknown': 'acceptance_unknown',
        ':claimOwner': input.expectedClaimOwner,
        ':claimEpoch': input.expectedClaimEpoch,
        ':expectedAttemptCount': input.expectedAttemptCount,
        ':observedAtEpochMs': input.observedAtEpochMs,
      },
    });
  }

  public async beginEffectDispatch(input: EffectDispatchInput): Promise<void> {
    assertPositiveInteger(input.artifactRevision, 'artifactRevision');
    assertEpochMs(input.startedAtEpochMs, 'startedAtEpochMs');
    assertSha256(input.artifactHash, 'artifactHash');
    try {
      await this.client.send(
        new PutCommand({
          TableName: input.tableName,
          Item: {
            ...this.effectKey(input),
            tenantId: input.tenantId,
            accountId: input.accountId,
            effectId: input.effectId,
            artifactRevision: input.artifactRevision,
            artifactHash: input.artifactHash,
            dispatchOwner: input.dispatchOwner,
            state: 'dispatching',
            startedAtEpochMs: input.startedAtEpochMs,
          },
          ConditionExpression:
            'attribute_not_exists(PK) AND attribute_not_exists(SK)',
        }),
      );
    } catch (error) {
      translatePersistenceError(error);
    }
  }

  public async persistEffectCorrelation(
    input: EffectCorrelationInput,
  ): Promise<void> {
    assertKeyedDigest(input.providerCorrelationDigest);
    assertSha256(input.providerResponseHash, 'providerResponseHash');
    assertEpochMs(input.observedAtEpochMs, 'observedAtEpochMs');
    const effectKey = this.effectKey(input);
    const correlationKey = this.keys.connectorEntity(
      input.tenantId,
      input.accountId,
      'correlation',
      input.providerCorrelationDigest,
    );
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: input.tableName,
                Item: {
                  ...correlationKey,
                  tenantId: input.tenantId,
                  accountId: input.accountId,
                  effectId: input.effectId,
                  artifactRevision: input.artifactRevision,
                  providerCorrelationDigest: input.providerCorrelationDigest,
                  providerResponseHash: input.providerResponseHash,
                  observedAtEpochMs: input.observedAtEpochMs,
                  immutable: true,
                },
                ConditionExpression:
                  'attribute_not_exists(PK) AND attribute_not_exists(SK)',
              },
            },
            {
              Update: {
                TableName: input.tableName,
                Key: effectKey,
                ConditionExpression:
                  '#tenant = :tenant AND #state = :dispatching AND #owner = :owner AND #artifactRevision = :artifactRevision AND attribute_not_exists(#correlationDigest)',
                UpdateExpression:
                  'SET #state = :correlationPersisted, #correlationDigest = :correlationDigest, #correlatedAtEpochMs = :observedAtEpochMs',
                ExpressionAttributeNames: {
                  '#tenant': 'tenantId',
                  '#state': 'state',
                  '#owner': 'dispatchOwner',
                  '#artifactRevision': 'artifactRevision',
                  '#correlationDigest': 'providerCorrelationDigest',
                  '#correlatedAtEpochMs': 'correlatedAtEpochMs',
                },
                ExpressionAttributeValues: {
                  ':tenant': input.tenantId,
                  ':dispatching': 'dispatching',
                  ':correlationPersisted': 'correlation_persisted',
                  ':owner': input.dispatchOwner,
                  ':artifactRevision': input.artifactRevision,
                  ':correlationDigest': input.providerCorrelationDigest,
                  ':observedAtEpochMs': input.observedAtEpochMs,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      translatePersistenceError(error);
    }
  }

  public async markEffectProviderAccepted(
    input: EffectAcceptanceInput,
  ): Promise<void> {
    assertKeyedDigest(input.providerCorrelationDigest);
    assertEpochMs(input.observedAtEpochMs, 'observedAtEpochMs');
    await this.updateWithConflictTranslation({
      TableName: input.tableName,
      Key: this.effectKey(input),
      ConditionExpression:
        '#tenant = :tenant AND #state = :correlationPersisted AND #artifactRevision = :artifactRevision AND #correlationDigest = :correlationDigest',
      UpdateExpression:
        'SET #state = :providerAccepted, #acceptedAtEpochMs = :observedAtEpochMs',
      ExpressionAttributeNames: {
        '#tenant': 'tenantId',
        '#state': 'state',
        '#artifactRevision': 'artifactRevision',
        '#correlationDigest': 'providerCorrelationDigest',
        '#acceptedAtEpochMs': 'acceptedAtEpochMs',
      },
      ExpressionAttributeValues: {
        ':tenant': input.tenantId,
        ':correlationPersisted': 'correlation_persisted',
        ':providerAccepted': 'provider_accepted',
        ':artifactRevision': input.artifactRevision,
        ':correlationDigest': input.providerCorrelationDigest,
        ':observedAtEpochMs': input.observedAtEpochMs,
      },
    });
  }

  public async freezeEffectAcceptanceUnknown(
    input: EffectAcceptanceUnknownInput,
  ): Promise<void> {
    assertEpochMs(input.observedAtEpochMs, 'observedAtEpochMs');
    await this.updateWithConflictTranslation({
      TableName: input.tableName,
      Key: this.effectKey(input),
      ConditionExpression:
        '#tenant = :tenant AND (#state = :dispatching OR #state = :correlationPersisted) AND #owner = :owner AND #artifactRevision = :artifactRevision',
      UpdateExpression:
        'SET #state = :unknown, #reconciliationRequired = :true, #acceptanceFrozenAtEpochMs = :observedAtEpochMs REMOVE #nextAttemptAtEpochMs',
      ExpressionAttributeNames: {
        '#tenant': 'tenantId',
        '#state': 'state',
        '#owner': 'dispatchOwner',
        '#artifactRevision': 'artifactRevision',
        '#reconciliationRequired': 'reconciliationRequired',
        '#acceptanceFrozenAtEpochMs': 'acceptanceFrozenAtEpochMs',
        '#nextAttemptAtEpochMs': 'nextAttemptAtEpochMs',
      },
      ExpressionAttributeValues: {
        ':tenant': input.tenantId,
        ':dispatching': 'dispatching',
        ':correlationPersisted': 'correlation_persisted',
        ':unknown': 'acceptance_unknown',
        ':owner': input.dispatchOwner,
        ':artifactRevision': input.artifactRevision,
        ':true': true,
        ':observedAtEpochMs': input.observedAtEpochMs,
      },
    });
  }

  public async queryBounded(
    tableName: string,
    indexName: string,
    partitionKey: string,
    partitionValue: string,
    limit: number,
  ): Promise<readonly Record<string, unknown>[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Query limit must be between 1 and 100.');
    const result = await this.client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: indexName,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': partitionKey },
        ExpressionAttributeValues: { ':pk': partitionValue },
        Limit: limit,
        ScanIndexForward: true,
      }),
    );
    return Object.freeze([...(result.Items ?? [])]);
  }

  private outboxKey(input: {
    readonly tenantId: string;
    readonly accountId: string;
    readonly outboxId: string;
  }): Readonly<{ PK: string; SK: string }> {
    return this.keys.connectorEntity(
      input.tenantId,
      input.accountId,
      'outbox',
      input.outboxId,
    );
  }

  private effectKey(input: {
    readonly tenantId: string;
    readonly accountId: string;
    readonly effectId: string;
  }): Readonly<{ PK: string; SK: string }> {
    return this.keys.connectorEntity(
      input.tenantId,
      input.accountId,
      'effect',
      input.effectId,
    );
  }

  private async updateWithConflictTranslation(
    input: ConstructorParameters<typeof UpdateCommand>[0],
  ): Promise<void> {
    try {
      await this.client.send(new UpdateCommand(input));
    } catch (error) {
      translatePersistenceError(error);
    }
  }
}
