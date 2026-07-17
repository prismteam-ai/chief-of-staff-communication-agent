import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactGetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  actionPlanSchema,
  contactChannelPolicySchema,
  type ProviderSendResult,
} from '@chief/contracts/approval';
import {
  connectorAccountRefSchema,
  connectorSnapshotSchema,
} from '@chief/contracts/connectors';
import {
  accountIdSchema,
  brandIdSchema,
  keyedDigestValueSchema,
  tenantIdSchema,
  type OperationId,
} from '@chief/contracts/ids';
import { verifiedActorContextSchema } from '@chief/contracts/tenancy';
import { describe, expect, it, vi } from 'vitest';

import {
  buildImmutableApprovalBundle,
  type OperationApprovalBinding,
} from './approval-service.js';
import { computeActionPlanHash } from './canonical.js';
import {
  approvalExecutionLookupKey,
  buildDynamoApprovalExecutionCreateTransaction,
  buildDynamoApprovalExecutionRecords,
  DynamoApprovalExecutionAuthorityProjectionWriter,
  DynamoApprovalExecutionPersistence,
  type DynamoApprovalExecutionRecords,
} from './dynamo-execution-persistence.js';
import {
  EffectDisabledSink,
  executeApprovedOperation,
  type AuthoritativeExecutionState,
  type OperationClaim,
} from './execution-service.js';

const NOW = '2026-07-17T12:00:00.000Z';
const RUN_AT = '2026-07-17T12:10:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const DIGEST = `h1_v1_${'A'.repeat(43)}`;

function fixture(): AuthoritativeExecutionState {
  const candidate = actionPlanSchema.parse({
    schemaVersion: '1',
    tenantId: 'tenant-redwood',
    actionPlanId: 'plan-send-001',
    revision: 1,
    sourceMessageRevisionId: 'message-revision-001',
    operations: [
      {
        kind: 'send_message',
        operationId: 'operation-send-001',
        connectorAccountId: 'account-gmail-001',
        draftRevisionId: 'draft-revision-001',
        recipientDigests: [DIGEST],
        renderedPayloadFingerprint: HASH_A,
      },
    ],
    policyVersion: 'approval-policy-v9',
    expiresAt: '2026-07-17T13:00:00.000Z',
    canonicalHash: HASH_B,
    createdAt: NOW,
  });
  const actionPlan = actionPlanSchema.parse({
    ...candidate,
    canonicalHash: computeActionPlanHash(candidate),
  });
  const snapshot = connectorSnapshotSchema.parse({
    connectorId: 'gmail',
    descriptorVersion: 'gmail-2026-07',
    accountId: 'account-gmail-001',
    capabilitySnapshotHash: HASH_B,
    runtimeMode: 'fixture',
    selectionState: 'selected',
  });
  const binding: OperationApprovalBinding = {
    operationId: actionPlan.operations[0]!.operationId,
    attemptId: 'attempt-001' as OperationApprovalBinding['attemptId'],
    account: connectorAccountRefSchema.parse({
      tenantId: 'tenant-redwood',
      accountId: 'account-gmail-001',
      expectedStateVersion: 11,
    }),
    connectorSnapshot: snapshot,
    renderedPayloadFingerprint: HASH_A,
    draftRevisionId:
      'draft-revision-001' as OperationApprovalBinding['draftRevisionId'],
    clientCorrelation: {
      kind: 'rfc_message_id',
      value: '<chief-operation-send-001@example.test>',
    },
    correlationBindingVersion: 'correlation-v1',
    reconciliationStrategy: 'gmail_sent_rfc_message_id',
    reconciliationStrategyVersion: '1',
    contactPolicies: [
      {
        tenantId: tenantIdSchema.parse('tenant-redwood'),
        contactIdentityDigest: keyedDigestValueSchema.parse(DIGEST),
        channel: 'email',
        connectorAccountId: accountIdSchema.parse('account-gmail-001'),
        brandId: brandIdSchema.parse('brand-redwood'),
        projectionVersion: 7,
      },
    ],
    effectSwitch: {
      globalVersion: 4,
      accountVersion: 6,
      operationVersion: 2,
      policy: 'effect_disabled',
    },
  };
  const actor = verifiedActorContextSchema.parse({
    authoritySource: 'verified_identity',
    tenantId: 'tenant-redwood',
    userId: 'executive-ada',
    accountScopes: ['account-gmail-001'],
    brandScopes: ['brand-redwood'],
    grants: ['actions:approve'],
    membershipVersion: 2,
    verifiedClaimsHash: HASH_A,
    verifiedAt: NOW,
  });
  const bundle = buildImmutableApprovalBundle({
    actor,
    actionPlan,
    approvalId: 'approval-send-001',
    executionIntentId: 'intent-send-001',
    approvedAt: '2026-07-17T12:05:00.000Z',
    bindings: [binding],
  });
  const policy = contactChannelPolicySchema.parse({
    schemaVersion: '1',
    tenantId: 'tenant-redwood',
    contactIdentityDigest: DIGEST,
    channel: 'email',
    connectorAccountId: 'account-gmail-001',
    brandId: 'brand-redwood',
    state: 'allowed',
    winningFactId: 'allow-fact-001',
    applicableFactIds: ['allow-fact-001'],
    reducerVersion: 'contact-policy-v2',
    projectionVersion: 7,
    updatedAt: '2026-07-17T12:04:00.000Z',
  });
  return {
    actionPlan: bundle.actionPlan,
    approval: bundle.approval,
    operation: bundle.operations[0]!,
    currentSourceMessageRevisionId: actionPlan.sourceMessageRevisionId,
    approverAuthorityActive: true,
    connector: {
      accountId: 'account-gmail-001',
      stateVersion: 11,
      status: 'active',
      health: 'healthy',
      snapshot,
      operationCapabilityEnabled: true,
    },
    contactPolicies: [policy],
    effectSwitch: {
      ...binding.effectSwitch,
      globalEnabled: false,
      accountEnabled: false,
      operationEnabled: false,
    },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface DynamoExpressionInput {
  readonly ConditionExpression?: string;
  readonly FilterExpression?: string;
  readonly KeyConditionExpression?: string;
  readonly ProjectionExpression?: string;
  readonly UpdateExpression?: string;
  readonly ExpressionAttributeNames?: Readonly<Record<string, string>>;
  readonly ExpressionAttributeValues?: Readonly<Record<string, unknown>>;
}

function expressionTokens(
  input: DynamoExpressionInput,
  pattern: RegExp,
): readonly string[] {
  const expressions = [
    input.ConditionExpression,
    input.FilterExpression,
    input.KeyConditionExpression,
    input.ProjectionExpression,
    input.UpdateExpression,
  ];
  return [
    ...new Set(
      expressions.flatMap((expression) => expression?.match(pattern) ?? []),
    ),
  ].sort();
}

function validateExpressionPlaceholders(input: DynamoExpressionInput): void {
  const referencedNames = expressionTokens(input, /#[A-Za-z0-9_]+/gu);
  const providedNames = Object.keys(
    input.ExpressionAttributeNames ?? {},
  ).sort();
  if (JSON.stringify(referencedNames) !== JSON.stringify(providedNames)) {
    throw new Error(
      `DYNAMO_EXPRESSION_NAME_PLACEHOLDER_MISMATCH:${JSON.stringify({ providedNames, referencedNames })}`,
    );
  }

  const referencedValues = expressionTokens(input, /:[A-Za-z0-9_]+/gu);
  const providedValues = Object.keys(
    input.ExpressionAttributeValues ?? {},
  ).sort();
  if (JSON.stringify(referencedValues) !== JSON.stringify(providedValues)) {
    throw new Error(
      `DYNAMO_EXPRESSION_VALUE_PLACEHOLDER_MISMATCH:${JSON.stringify({ providedValues, referencedValues })}`,
    );
  }
}

class DynamoCommandStore {
  public item: Record<string, unknown> | undefined;
  public authority: Record<string, unknown> | undefined;
  public locator: Record<string, unknown> | undefined;
  public authoritativeMiss = false;
  public beforeNextUpdate: (() => void) | undefined;
  public conditionalFailures = 0;
  public readonly commands: unknown[] = [];

  public constructor(records?: DynamoApprovalExecutionRecords) {
    this.item =
      records === undefined
        ? undefined
        : (clone(records.aggregate) as unknown as Record<string, unknown>);
    this.authority =
      records === undefined
        ? undefined
        : (clone(records.authority) as unknown as Record<string, unknown>);
    this.locator =
      records === undefined
        ? undefined
        : (clone(records.locator) as unknown as Record<string, unknown>);
  }

  public send(command: unknown): Promise<Record<string, unknown>> {
    return Promise.resolve().then(() => this.execute(command));
  }

  private execute(command: unknown): Record<string, unknown> {
    this.commands.push(command);
    if (command instanceof GetCommand) {
      validateExpressionPlaceholders(command.input);
      const record = this.record(command.input.Key);
      return record === undefined ? {} : { Item: clone(record) };
    }
    if (command instanceof TransactGetCommand) {
      return {
        Responses: (command.input.TransactItems ?? []).map(({ Get }) => {
          if (Get === undefined || this.authoritativeMiss) return {};
          validateExpressionPlaceholders(Get);
          const record = this.record(Get.Key);
          return record === undefined ? {} : { Item: clone(record) };
        }),
      };
    }
    if (command instanceof TransactWriteCommand) {
      this.executeTransaction(command);
      return {};
    }
    if (!(command instanceof UpdateCommand) || this.item === undefined) {
      throw new Error('UNEXPECTED_DYNAMO_COMMAND');
    }
    const input = command.input;
    validateExpressionPlaceholders(input);
    this.runBeforeNextUpdate();
    if (!this.conditionMatches(this.item, input)) this.conditionalFailure();
    this.applyUpdate(this.item, input);
    return {};
  }

  private executeTransaction(command: TransactWriteCommand): void {
    const items = command.input.TransactItems ?? [];
    for (const transaction of items) {
      if (transaction.Put !== undefined) {
        validateExpressionPlaceholders(transaction.Put);
        if (this.record(transaction.Put.Item) !== undefined) {
          this.transactionFailure();
        }
      }
      if (transaction.ConditionCheck !== undefined) {
        validateExpressionPlaceholders(transaction.ConditionCheck);
        const record = this.record(transaction.ConditionCheck.Key);
        if (
          record === undefined ||
          !this.conditionMatches(record, transaction.ConditionCheck)
        ) {
          this.transactionFailure();
        }
      }
      if (transaction.Update !== undefined) {
        validateExpressionPlaceholders(transaction.Update);
        this.runBeforeNextUpdate();
        const record = this.record(transaction.Update.Key);
        if (
          record === undefined ||
          !this.conditionMatches(record, transaction.Update)
        ) {
          this.transactionFailure();
        }
      }
    }
    for (const transaction of items) {
      if (transaction.Put !== undefined) {
        if (transaction.Put.Item === undefined) this.transactionFailure();
        this.putRecord(clone(transaction.Put.Item));
      }
      if (transaction.Update !== undefined) {
        const record = this.record(transaction.Update.Key);
        if (record === undefined) this.transactionFailure();
        this.applyUpdate(record, transaction.Update);
      }
    }
  }

  private conditionMatches(
    actual: Record<string, unknown>,
    input: DynamoExpressionInput,
  ): boolean {
    const values = input.ExpressionAttributeValues ?? {};
    const matches = (attribute: string, expected: string): boolean =>
      actual[attribute] === values[expected];
    const condition = input.ConditionExpression ?? '';
    if (
      (values[':tenantId'] !== undefined &&
        !matches('tenantId', ':tenantId')) ||
      (values[':operationId'] !== undefined &&
        !matches('operationId', ':operationId')) ||
      (values[':expectedStatus'] !== undefined &&
        !matches('executionStatus', ':expectedStatus')) ||
      (condition.includes('#claimOwner = :claimOwner') &&
        !matches('claimOwner', ':claimOwner')) ||
      (condition.includes('#claimEpoch = :claimEpoch') &&
        !matches('claimEpoch', ':claimEpoch')) ||
      (values[':expectedClaimEpoch'] !== undefined &&
        !matches('claimEpoch', ':expectedClaimEpoch')) ||
      (values[':expectedStateVersion'] !== undefined &&
        !matches('stateVersion', ':expectedStateVersion')) ||
      (values[':artifactHash'] !== undefined &&
        !matches('artifactHash', ':artifactHash')) ||
      (values[':authorityVersion'] !== undefined &&
        !matches('authorityVersion', ':authorityVersion')) ||
      (values[':expectedAuthorityVersion'] !== undefined &&
        !matches('authorityVersion', ':expectedAuthorityVersion')) ||
      (values[':authorityType'] !== undefined &&
        !matches('entityType', ':authorityType')) ||
      (values[':aggregateType'] !== undefined &&
        !matches('entityType', ':aggregateType')) ||
      (values[':locatorType'] !== undefined &&
        !matches('entityType', ':locatorType')) ||
      (values[':authorityPK'] !== undefined &&
        !matches('authorityPK', ':authorityPK')) ||
      (values[':authoritySK'] !== undefined &&
        !matches('authoritySK', ':authoritySK'))
    ) {
      return false;
    }
    if (
      input.ConditionExpression?.includes(
        '#claimExpiresAtEpochMs < :nowEpochMs',
      ) &&
      Number(actual.claimExpiresAtEpochMs) >= Number(values[':nowEpochMs'])
    ) {
      return false;
    }
    if (
      input.ConditionExpression?.includes(
        '#claimExpiresAtEpochMs < :observedAtEpochMs',
      ) &&
      Number(actual.claimExpiresAtEpochMs) >=
        Number(values[':observedAtEpochMs'])
    ) {
      return false;
    }
    if (
      input.ConditionExpression?.includes(
        '#claimExpiresAtEpochMs >= :attemptedAtEpochMs',
      ) &&
      Number(actual.claimExpiresAtEpochMs) <
        Number(values[':attemptedAtEpochMs'])
    ) {
      return false;
    }
    if (
      input.ConditionExpression?.includes(
        'attribute_not_exists(#dispatchAttempt)',
      ) &&
      actual.dispatchAttempt !== undefined
    ) {
      return false;
    }
    if (
      input.ConditionExpression?.includes(
        'attribute_not_exists(#providerCorrelation)',
      ) &&
      actual.providerCorrelation !== undefined
    ) {
      return false;
    }
    return true;
  }

  private applyUpdate(
    actual: Record<string, unknown>,
    input: DynamoExpressionInput,
  ): void {
    const values = input.ExpressionAttributeValues ?? {};
    const names = input.ExpressionAttributeNames ?? {};
    if (values[':claimed'] !== undefined) {
      actual.executionStatus = values[':claimed'];
      actual.claimOwner = values[':claimOwner'];
      actual.claimEpoch = values[':nextClaimEpoch'];
      actual.claimExpiresAtEpochMs = values[':leaseExpiresAtEpochMs'];
    } else if (
      values[':dispatching'] !== undefined &&
      values[':dispatchAttempt'] !== undefined
    ) {
      actual.executionStatus = values[':dispatching'];
      actual.dispatchAttempt = clone(values[':dispatchAttempt']);
      actual.attemptCount = values[':nextAttemptCount'];
    } else if (values[':settled'] !== undefined) {
      actual.executionStatus = values[':settled'];
      actual.executionOutcome = values[':executionOutcome'];
      actual.providerResult = values[':providerResult'];
      actual.providerCorrelation = values[':providerCorrelation'];
      actual.effectDisabledReceipt = values[':effectDisabledReceipt'];
      actual.settledAt = values[':settledAt'];
      delete actual.claimOwner;
      delete actual.claimExpiresAtEpochMs;
    } else if (values[':reconciliationRequired'] !== undefined) {
      actual.executionStatus = values[':reconciliationRequired'];
      actual.executionOutcome = values[':acceptanceUnknown'];
      actual.reasonCode = values[':reasonCode'];
      actual.retryDecision = values[':retryDenied'];
      actual.acceptanceFrozenAt = values[':acceptanceFrozenAt'];
      if (values[':providerResponseHash'] !== undefined) {
        actual.providerResponseHash = values[':providerResponseHash'];
      }
      delete actual.claimOwner;
      delete actual.claimExpiresAtEpochMs;
    } else if (values[':ready'] !== undefined) {
      actual.executionStatus = values[':ready'];
      delete actual.claimOwner;
      delete actual.claimExpiresAtEpochMs;
    } else if (values[':currentAuthority'] !== undefined) {
      actual.currentAuthority = clone(values[':currentAuthority']);
      actual.authorityVersion = values[':nextAuthorityVersion'];
      actual.updatedAt = values[':updatedAt'];
    } else if (values[':nextAuthorityVersion'] !== undefined) {
      actual.authorityVersion = values[':nextAuthorityVersion'];
    } else {
      throw new Error(`UNSUPPORTED_UPDATE:${JSON.stringify(names)}`);
    }
    if (values[':nextStateVersion'] !== undefined) {
      actual.stateVersion = values[':nextStateVersion'];
    }
  }

  private record(
    key: Readonly<Record<string, unknown>> | undefined,
  ): Record<string, unknown> | undefined {
    if (key === undefined) return undefined;
    return [this.item, this.authority, this.locator].find(
      (record) =>
        record !== undefined && record.PK === key.PK && record.SK === key.SK,
    );
  }

  private putRecord(record: Record<string, unknown>): void {
    if (record.entityType === 'approval_execution') this.item = record;
    else if (record.entityType === 'approval_execution_authority') {
      this.authority = record;
    } else if (record.entityType === 'approval_execution_locator') {
      this.locator = record;
    } else throw new Error('UNSUPPORTED_PUT');
  }

  private conditionalFailure(): never {
    this.conditionalFailures += 1;
    throw new ConditionalCheckFailedException({
      $metadata: {},
      message: 'private conditional detail',
    });
  }

  private transactionFailure(): never {
    this.conditionalFailures += 1;
    const error = new Error('private transaction detail');
    error.name = 'TransactionCanceledException';
    throw error;
  }

  private runBeforeNextUpdate(): void {
    const action = this.beforeNextUpdate;
    this.beforeNextUpdate = undefined;
    action?.();
  }
}

function persistence(store: DynamoCommandStore) {
  return new DynamoApprovalExecutionPersistence({
    client: store as never,
    coreTableName: 'chief-core',
    now: () => RUN_AT,
  });
}

function item() {
  return buildDynamoApprovalExecutionRecords({
    state: fixture(),
    createdAt: NOW,
  });
}

async function claimed(store: DynamoCommandStore) {
  const repository = persistence(store);
  const result = await repository.claimOperation({
    operationId: 'operation-send-001' as OperationId,
    claimOwner: 'worker-a',
    now: RUN_AT,
    leaseDurationMs: 30_000,
  });
  if (result.status !== 'claimed') throw new Error('EXPECTED_CLAIM');
  await repository.loadAuthoritativeState(result.claim.operationId);
  return { repository, claim: result.claim };
}

describe('DynamoApprovalExecutionPersistence', () => {
  it('rejects unused and missing Dynamo expression placeholders in the validation fake', () => {
    expect(() =>
      validateExpressionPlaceholders({
        ConditionExpression: '#status = :status',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#unused': 'unused',
        },
        ExpressionAttributeValues: { ':status': 'ready' },
      }),
    ).toThrow('DYNAMO_EXPRESSION_NAME_PLACEHOLDER_MISMATCH');

    expect(() =>
      validateExpressionPlaceholders({
        ConditionExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
      }),
    ).toThrow('DYNAMO_EXPRESSION_VALUE_PLACEHOLDER_MISMATCH');
  });

  it('builds a tenant-scoped aggregate with a bounded operation locator', () => {
    const created = item();
    expect(created.aggregate).toMatchObject({
      PK: 'T#dGVuYW50LXJlZHdvb2Q',
      entityType: 'approval_execution',
      executionStatus: 'ready',
      claimEpoch: 0,
    });
    expect(created.aggregate.SK).toContain('YXBwcm92YWwtZXhlY3V0aW9u');
    expect(created.locator).toMatchObject({
      PK: approvalExecutionLookupKey('operation-send-001'),
      entityType: 'approval_execution_locator',
      tenantId: 'tenant-redwood',
      aggregatePK: created.aggregate.PK,
      authorityPK: created.authority.PK,
    });
    expect(created.authority).toMatchObject({
      entityType: 'approval_execution_authority',
      authorityVersion: 1,
    });
  });

  it('runs approved immutable operation through claim, guard, and effect-disabled receipt', async () => {
    const store = new DynamoCommandStore(item());
    const repository = persistence(store);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await executeApprovedOperation(
      repository,
      new EffectDisabledSink(() => RUN_AT),
      {
        operationId: 'operation-send-001' as OperationId,
        workerId: 'worker-a',
        observedAt: RUN_AT,
        leaseDurationMs: 30_000,
      },
    );
    expect(result).toMatchObject({ status: 'effect_disabled' });
    expect(store.item).toMatchObject({
      executionStatus: 'settled',
      executionOutcome: 'effect_disabled',
      effectDisabledReceipt: {
        kind: 'effect_disabled',
        operationId: 'operation-send-001',
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(
      repository.claimOperation({
        operationId: 'operation-send-001' as OperationId,
        claimOwner: 'worker-redrive',
        now: RUN_AT,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toEqual({ status: 'duplicate' });
    const locatorReads = store.commands.filter(
      (command): command is GetCommand =>
        command instanceof GetCommand &&
        command.input.Key?.PK ===
          approvalExecutionLookupKey('operation-send-001'),
    );
    expect(locatorReads.length).toBeGreaterThan(0);
    expect(
      locatorReads.every(({ input }) => input.ConsistentRead === true),
    ).toBe(true);
    expect(
      store.commands.some((command) => command instanceof TransactGetCommand),
    ).toBe(true);
    expect(JSON.stringify(store.commands)).not.toMatch(/Query|Scan/u);
  });

  it('keeps near-limit dispatch bounded and rejects oversized state before claim', async () => {
    const nearLimit = new DynamoCommandStore(item());
    if (nearLimit.item === undefined || nearLimit.authority === undefined) {
      throw new Error('EXPECTED_EXECUTION_RECORDS');
    }
    const currentBytes = Buffer.byteLength(
      JSON.stringify([nearLimit.item, nearLimit.authority]),
      'utf8',
    );
    nearLimit.item.padding = 'x'.repeat(319 * 1_024 - currentBytes - 32);
    expect(
      Buffer.byteLength(
        JSON.stringify([nearLimit.item, nearLimit.authority]),
        'utf8',
      ),
    ).toBeLessThanOrEqual(320 * 1_024);

    await expect(
      executeApprovedOperation(
        persistence(nearLimit),
        new EffectDisabledSink(() => RUN_AT),
        {
          operationId: 'operation-send-001' as OperationId,
          workerId: 'worker-near-limit',
          observedAt: RUN_AT,
          leaseDurationMs: 30_000,
        },
      ),
    ).resolves.toMatchObject({ status: 'effect_disabled' });
    expect(
      Buffer.byteLength(JSON.stringify(nearLimit.item), 'utf8'),
    ).toBeLessThan(400 * 1_024);
    expect(nearLimit.item.dispatchAttempt).not.toHaveProperty('artifact');
    expect(nearLimit.item.dispatchAttempt).toMatchObject({
      operationId: 'operation-send-001',
      attemptId: 'attempt-001',
      artifactHash: fixture().operation.artifactHash,
    });

    const oversized = new DynamoCommandStore(item());
    if (oversized.item === undefined) throw new Error('EXPECTED_ITEM');
    oversized.item.padding = 'x'.repeat(321 * 1_024);
    await expect(
      persistence(oversized).claimOperation({
        operationId: 'operation-send-001' as OperationId,
        claimOwner: 'worker-oversized',
        now: RUN_AT,
        leaseDurationMs: 30_000,
      }),
    ).rejects.toThrow('APPROVAL_EXECUTION_RECORD_TOO_LARGE');
    expect(
      oversized.commands.some(
        (command) =>
          command instanceof UpdateCommand ||
          command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
  });

  it('allows one conditional claim winner and returns contention for the duplicate', async () => {
    const store = new DynamoCommandStore(item());
    const first = persistence(store);
    const second = persistence(store);
    const [left, right] = await Promise.all([
      first.claimOperation({
        operationId: 'operation-send-001' as OperationId,
        claimOwner: 'worker-a',
        now: RUN_AT,
        leaseDurationMs: 30_000,
      }),
      second.claimOperation({
        operationId: 'operation-send-001' as OperationId,
        claimOwner: 'worker-b',
        now: RUN_AT,
        leaseDurationMs: 30_000,
      }),
    ]);
    expect([left.status, right.status].sort()).toEqual([
      'claimed',
      'contended',
    ]);
    expect(store.item?.claimEpoch).toBe(1);
  });

  it('takes over an expired uncalled claim with a new epoch but freezes expired dispatch', async () => {
    const claimStore = new DynamoCommandStore(item());
    if (claimStore.item === undefined) throw new Error('EXPECTED_ITEM');
    claimStore.item.executionStatus = 'claimed';
    claimStore.item.claimOwner = 'dead-worker';
    claimStore.item.claimEpoch = 3;
    claimStore.item.claimExpiresAtEpochMs = Date.parse(RUN_AT) - 1;
    claimStore.item.stateVersion = 4;
    await expect(
      persistence(claimStore).claimOperation({
        operationId: 'operation-send-001' as OperationId,
        claimOwner: 'worker-recovery',
        now: RUN_AT,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toMatchObject({
      status: 'claimed',
      claim: { claimEpoch: 4 },
    });

    const dispatchStore = new DynamoCommandStore(item());
    if (dispatchStore.item === undefined) throw new Error('EXPECTED_ITEM');
    dispatchStore.item.executionStatus = 'dispatching';
    dispatchStore.item.claimOwner = 'dead-worker';
    dispatchStore.item.claimEpoch = 9;
    dispatchStore.item.claimExpiresAtEpochMs = Date.parse(RUN_AT) - 1;
    dispatchStore.item.stateVersion = 10;
    dispatchStore.item.dispatchAttempt = { artifactHash: HASH_A };
    await expect(
      persistence(dispatchStore).claimOperation({
        operationId: 'operation-send-001' as OperationId,
        claimOwner: 'worker-recovery',
        now: RUN_AT,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toEqual({ status: 'frozen' });
    expect(dispatchStore.item).toMatchObject({
      executionStatus: 'reconciliation_required',
      executionOutcome: 'acceptance_unknown',
      reasonCode: 'dispatch_lease_expired',
      retryDecision: 'retry_denied',
    });
  });

  it.each([
    ['tenantId', 'tenant-attacker'],
    ['operationId', 'operation-attacker'],
    ['artifactHash', HASH_B],
  ])(
    'fences expired-dispatch freeze when %s changes after hydration',
    async (attribute, changedValue) => {
      const store = new DynamoCommandStore(item());
      if (store.item === undefined) throw new Error('EXPECTED_ITEM');
      store.item.executionStatus = 'dispatching';
      store.item.claimOwner = 'dead-worker';
      store.item.claimEpoch = 9;
      store.item.claimExpiresAtEpochMs = Date.parse(RUN_AT) - 1;
      store.item.stateVersion = 10;
      store.item.dispatchAttempt = { artifactHash: HASH_A };
      store.beforeNextUpdate = () => {
        if (store.item !== undefined) store.item[attribute] = changedValue;
      };

      await expect(
        persistence(store).claimOperation({
          operationId: 'operation-send-001' as OperationId,
          claimOwner: 'worker-recovery',
          now: RUN_AT,
          leaseDurationMs: 30_000,
        }),
      ).rejects.toThrow();
      expect(store.conditionalFailures).toBe(1);
      expect(store.item.executionStatus).toBe('dispatching');
      expect(store.item).not.toHaveProperty('acceptanceFrozenAt');
    },
  );

  it('fences stale owner/epoch objects and conditional state-version changes', async () => {
    const store = new DynamoCommandStore(item());
    const { repository, claim } = await claimed(store);
    const clonedClaim: OperationClaim = {
      ...claim,
      claimEpoch: claim.claimEpoch,
    };
    await expect(
      repository.persistDispatchAttempt(
        clonedClaim,
        fixture().operation.artifact,
      ),
    ).rejects.toThrow('STALE_OR_UNRECOGNIZED_OPERATION_CLAIM');

    if (store.item === undefined) throw new Error('EXPECTED_ITEM');
    store.item.stateVersion = Number(store.item.stateVersion) + 1;
    await expect(
      repository.persistDispatchAttempt(claim, fixture().operation.artifact),
    ).rejects.toThrow('DYNAMO_EXECUTION_CONDITIONAL_RACE');
  });

  it('refuses dispatch when the otherwise matching claim lease has expired', async () => {
    const store = new DynamoCommandStore(item());
    const { repository, claim } = await claimed(store);
    if (store.item === undefined) throw new Error('EXPECTED_ITEM');
    store.item.claimExpiresAtEpochMs = Date.parse(RUN_AT) - 1;

    await expect(
      repository.persistDispatchAttempt(claim, fixture().operation.artifact),
    ).rejects.toThrow('DYNAMO_EXECUTION_CONDITIONAL_RACE');
    expect(store.item).not.toHaveProperty('dispatchAttempt');
    expect(store.item.executionStatus).toBe('claimed');
  });

  it('atomically settles accepted correlation and rejected outcomes', async () => {
    const acceptedStore = new DynamoCommandStore(item());
    const accepted = await claimed(acceptedStore);
    await accepted.repository.persistDispatchAttempt(
      accepted.claim,
      fixture().operation.artifact,
    );
    await accepted.repository.settleAcceptedAndCorrelation(accepted.claim, {
      outcome: 'accepted',
      providerResponseHash: HASH_A,
      providerCorrelation: 'provider-message-991',
      observedAt: RUN_AT,
    });
    expect(acceptedStore.item).toMatchObject({
      executionStatus: 'settled',
      executionOutcome: 'provider_accepted',
      providerCorrelation: 'provider-message-991',
      providerResult: { outcome: 'accepted' },
    });
    const acceptedUpdate = acceptedStore.commands
      .filter((command) => command instanceof UpdateCommand)
      .at(-1) as UpdateCommand;
    expect(acceptedUpdate.input.ConditionExpression).toContain(
      'attribute_not_exists(#providerCorrelation)',
    );

    const rejectedStore = new DynamoCommandStore(item());
    const rejected = await claimed(rejectedStore);
    await rejected.repository.persistDispatchAttempt(
      rejected.claim,
      fixture().operation.artifact,
    );
    const result: Extract<ProviderSendResult, { outcome: 'rejected' }> = {
      outcome: 'rejected',
      providerResponseHash: HASH_B,
      reasonCode: 'provider_policy_denied',
      observedAt: RUN_AT,
    };
    await rejected.repository.settleRejected(rejected.claim, result);
    expect(rejectedStore.item).toMatchObject({
      executionStatus: 'settled',
      executionOutcome: 'provider_rejected',
      providerResult: result,
    });
  });

  it('bounds oversized accepted correlation and redacts oversized rejected reasons', async () => {
    const acceptedStore = new DynamoCommandStore(item());
    const accepted = await claimed(acceptedStore);
    await accepted.repository.persistDispatchAttempt(
      accepted.claim,
      fixture().operation.artifact,
    );
    const oversizedCorrelation = `provider-private-${'x'.repeat(1_025)}`;
    await expect(
      accepted.repository.settleAcceptedAndCorrelation(accepted.claim, {
        outcome: 'accepted',
        providerResponseHash: HASH_A,
        providerCorrelation: oversizedCorrelation,
        observedAt: RUN_AT,
      }),
    ).rejects.toThrow('PROVIDER_RESULT_EXCEEDS_PERSISTENCE_LIMIT');
    await accepted.repository.freezeAcceptanceUnknown(
      accepted.claim,
      'correlation_persistence_failed',
      {
        outcome: 'acceptance_unknown',
        providerResponseHash: HASH_A,
        reasonCode: 'correlation_persistence_failed',
        observedAt: RUN_AT,
      },
    );
    expect(JSON.stringify(acceptedStore.item)).not.toContain(
      oversizedCorrelation,
    );
    expect(acceptedStore.item).toMatchObject({
      executionStatus: 'reconciliation_required',
      executionOutcome: 'acceptance_unknown',
    });

    const rejectedStore = new DynamoCommandStore(item());
    const rejected = await claimed(rejectedStore);
    await rejected.repository.persistDispatchAttempt(
      rejected.claim,
      fixture().operation.artifact,
    );
    const oversizedReason = `provider-private-${'y'.repeat(5_000)}`;
    await rejected.repository.settleRejected(rejected.claim, {
      outcome: 'rejected',
      providerResponseHash: HASH_B,
      reasonCode: oversizedReason,
      observedAt: RUN_AT,
    });
    expect(rejectedStore.item).toMatchObject({
      executionStatus: 'settled',
      providerResult: { reasonCode: 'PROVIDER_REJECTED' },
    });
    expect(JSON.stringify(rejectedStore.item)).not.toContain(oversizedReason);
    expect(
      Buffer.byteLength(JSON.stringify(rejectedStore.item), 'utf8'),
    ).toBeLessThan(400 * 1_024);
  });

  it('freezes unknown acceptance, redacts unsafe reason text, and denies redrive', async () => {
    const store = new DynamoCommandStore(item());
    const { repository, claim } = await claimed(store);
    await repository.persistDispatchAttempt(
      claim,
      fixture().operation.artifact,
    );
    await repository.freezeAcceptanceUnknown(
      claim,
      'token=secret provider raw error',
      {
        outcome: 'acceptance_unknown',
        providerResponseHash: HASH_A,
        reasonCode: 'provider_timeout',
        observedAt: RUN_AT,
      },
    );
    expect(store.item).toMatchObject({
      executionStatus: 'reconciliation_required',
      executionOutcome: 'acceptance_unknown',
      reasonCode: 'ACCEPTANCE_UNKNOWN',
      retryDecision: 'retry_denied',
      providerResponseHash: HASH_A,
    });
    expect(JSON.stringify(store.item)).not.toContain('token=secret');
    await expect(
      persistence(store).claimOperation({
        operationId: 'operation-send-001' as OperationId,
        claimOwner: 'worker-redrive',
        now: RUN_AT,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toEqual({ status: 'frozen' });

    const noHashStore = new DynamoCommandStore(item());
    const noHash = await claimed(noHashStore);
    await noHash.repository.persistDispatchAttempt(
      noHash.claim,
      fixture().operation.artifact,
    );
    await noHash.repository.freezeAcceptanceUnknown(
      noHash.claim,
      'sink_call_threw',
    );
    expect(noHashStore.item).toMatchObject({
      executionStatus: 'reconciliation_required',
      reasonCode: 'sink_call_threw',
    });
    expect(noHashStore.item).not.toHaveProperty('providerResponseHash');
  });

  it('atomically rejects an operation locator collision without partial writes', async () => {
    const collision = new DynamoCommandStore(item());
    const before = clone({
      item: collision.item,
      authority: collision.authority,
      locator: collision.locator,
    });
    const create = buildDynamoApprovalExecutionCreateTransaction({
      tableName: 'chief-core',
      state: fixture(),
      createdAt: NOW,
    });
    await expect(
      collision.send(new TransactWriteCommand(create)),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect({
      item: collision.item,
      authority: collision.authority,
      locator: collision.locator,
    }).toEqual(before);

    const empty = new DynamoCommandStore();
    await expect(empty.send(new TransactWriteCommand(create))).resolves.toEqual(
      {},
    );
    expect(empty.locator).toMatchObject({
      PK: approvalExecutionLookupKey('operation-send-001'),
      entityType: 'approval_execution_locator',
    });
    expect(empty.item).toBeDefined();
    expect(empty.authority).toBeDefined();
  });

  it('fails closed on missing or malformed locator, aggregate, and authority records', async () => {
    const authoritativeMiss = new DynamoCommandStore(item());
    authoritativeMiss.authoritativeMiss = true;
    await expect(
      persistence(authoritativeMiss).claimOperation({
        operationId: 'operation-send-001' as OperationId,
        claimOwner: 'worker-a',
        now: RUN_AT,
        leaseDurationMs: 30_000,
      }),
    ).rejects.toThrow('AUTHORITATIVE_EXECUTION_STATE_NOT_FOUND');

    const missing = new DynamoCommandStore();
    await expect(
      persistence(missing).loadAuthoritativeState(
        'operation-send-001' as OperationId,
      ),
    ).resolves.toBeUndefined();

    const malformed = new DynamoCommandStore(item());
    if (malformed.item === undefined) throw new Error('EXPECTED_ITEM');
    delete (malformed.item.immutableState as Record<string, unknown>).approval;
    await expect(
      persistence(malformed).loadAuthoritativeState(
        'operation-send-001' as OperationId,
      ),
    ).rejects.toThrow();
  });

  it.each([
    [
      'approver revocation',
      (authority: Record<string, unknown>) => {
        authority.approverAuthorityActive = false;
      },
      'APPROVER_AUTHORITY_REVOKED',
    ],
    [
      'effect-switch change',
      (authority: Record<string, unknown>) => {
        const effectSwitch = authority.effectSwitch as Record<string, unknown>;
        effectSwitch.globalVersion = Number(effectSwitch.globalVersion) + 1;
      },
      'EFFECT_SWITCH_VERSION_CHANGED',
    ],
    [
      'account capability revocation',
      (authority: Record<string, unknown>) => {
        const connector = authority.connector as Record<string, unknown>;
        connector.operationCapabilityEnabled = false;
      },
      'CONNECTOR_CAPABILITY_SUPPRESSED',
    ],
    [
      'contact suppression',
      (authority: Record<string, unknown>) => {
        const policies = authority.contactPolicies as Record<string, unknown>[];
        policies[0]!.state = 'suppressed';
      },
      'contact policy is suppressed',
    ],
  ])(
    'hydrates current authority and denies %s',
    async (_label, mutate, code) => {
      const store = new DynamoCommandStore(item());
      if (store.authority === undefined) throw new Error('EXPECTED_AUTHORITY');
      const currentAuthority = clone(
        store.authority.currentAuthority,
      ) as Record<string, unknown>;
      mutate(currentAuthority);
      const writer = new DynamoApprovalExecutionAuthorityProjectionWriter({
        client: store as never,
        coreTableName: 'chief-core',
      });
      await writer.update({
        tenantId: 'tenant-redwood',
        operationId: 'operation-send-001',
        expectedAuthorityVersion: 1,
        currentAuthority: currentAuthority as never,
        updatedAt: RUN_AT,
      });
      await expect(
        executeApprovedOperation(
          persistence(store),
          new EffectDisabledSink(() => RUN_AT),
          {
            operationId: 'operation-send-001' as OperationId,
            workerId: 'worker-authority-check',
            observedAt: RUN_AT,
            leaseDurationMs: 30_000,
          },
        ),
      ).rejects.toThrow(code);
      expect(store.item).toMatchObject({ executionStatus: 'ready' });
      expect(store.item).not.toHaveProperty('dispatchAttempt');
    },
  );

  it('fences dispatch when authority changes after hydration', async () => {
    const store = new DynamoCommandStore(item());
    const { repository, claim } = await claimed(store);
    if (store.authority === undefined) throw new Error('EXPECTED_AUTHORITY');
    const currentAuthority = clone(store.authority.currentAuthority) as Record<
      string,
      unknown
    >;
    currentAuthority.approverAuthorityActive = false;
    await new DynamoApprovalExecutionAuthorityProjectionWriter({
      client: store as never,
      coreTableName: 'chief-core',
    }).update({
      tenantId: 'tenant-redwood',
      operationId: 'operation-send-001',
      expectedAuthorityVersion: 1,
      currentAuthority: currentAuthority as never,
      updatedAt: RUN_AT,
    });

    await expect(
      repository.persistDispatchAttempt(claim, fixture().operation.artifact),
    ).rejects.toThrow('DYNAMO_EXECUTION_CONDITIONAL_RACE');
    expect(store.item).not.toHaveProperty('dispatchAttempt');
  });
});
