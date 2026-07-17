import {
  GetCommand,
  TransactGetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  actionPlanSchema,
  contactChannelPolicySchema,
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
import {
  buildImmutableApprovalBundle,
  type OperationApprovalBinding,
} from '@chief/approval-outbox/approval-service';
import { computeActionPlanHash } from '@chief/approval-outbox/canonical';
import {
  buildDynamoApprovalExecutionRecords,
  type DynamoApprovalExecutionRecords,
} from '@chief/approval-outbox/dynamo-execution-persistence';
import type { AuthoritativeExecutionState } from '@chief/approval-outbox/execution-service';
import { describe, expect, it, vi } from 'vitest';

import { createAwsEffectDisabledExecutionHandler } from './aws-composition.js';
import { createProductionExecutionModuleHandler } from './handler.js';

const NOW = '2026-07-17T12:00:00.000Z';
const RUN_AT = '2026-07-17T12:10:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const DIGEST = `h1_v1_${'A'.repeat(43)}`;
const ENVIRONMENT = Object.freeze({
  EXECUTION_RUNTIME_MODE: 'effect_disabled',
  CORE_TABLE_NAME: 'chief-core-table',
  EXECUTION_WORKER_ID: 'chief-execution-worker',
  EXECUTION_LEASE_DURATION_MS: '120000',
  EXTERNAL_EFFECTS: 'disabled',
  MODEL_EFFECTS: 'disabled',
  PROVIDER_EFFECTS: 'disabled',
  WORK_MANAGEMENT_EFFECTS: 'disabled',
});

function authoritativeState(): AuthoritativeExecutionState {
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

class CompositionDynamoStore {
  public item: Record<string, unknown> | undefined;
  public authority: Record<string, unknown> | undefined;
  public locator: Record<string, unknown> | undefined;
  public readonly commands: unknown[] = [];

  public constructor(records?: DynamoApprovalExecutionRecords) {
    this.item =
      records === undefined
        ? undefined
        : (structuredClone(records.aggregate) as unknown as Record<
            string,
            unknown
          >);
    this.authority =
      records === undefined
        ? undefined
        : (structuredClone(records.authority) as unknown as Record<
            string,
            unknown
          >);
    this.locator =
      records === undefined
        ? undefined
        : (structuredClone(records.locator) as unknown as Record<
            string,
            unknown
          >);
  }

  public send(command: unknown): Promise<Record<string, unknown>> {
    return Promise.resolve().then(() => {
      this.commands.push(command);
      if (command instanceof GetCommand) {
        return this.locator === undefined
          ? {}
          : { Item: structuredClone(this.locator) };
      }
      if (command instanceof TransactGetCommand) {
        return this.item === undefined || this.authority === undefined
          ? { Responses: [{}, {}] }
          : {
              Responses: [
                { Item: structuredClone(this.item) },
                { Item: structuredClone(this.authority) },
              ],
            };
      }
      if (command instanceof TransactWriteCommand) {
        if (this.item === undefined || this.authority === undefined) {
          throw new Error('UNEXPECTED_DYNAMO_COMMAND');
        }
        const condition = command.input.TransactItems?.[0]?.ConditionCheck;
        const update = command.input.TransactItems?.[1]?.Update;
        if (
          condition?.ExpressionAttributeValues?.[':authorityVersion'] !==
          this.authority.authorityVersion
        ) {
          const error = new Error('private transaction detail');
          error.name = 'TransactionCanceledException';
          throw error;
        }
        if (update === undefined) throw new Error('UNEXPECTED_DYNAMO_COMMAND');
        this.applyUpdate(update.ExpressionAttributeValues ?? {});
        return {};
      }
      if (!(command instanceof UpdateCommand) || this.item === undefined) {
        throw new Error('UNEXPECTED_DYNAMO_COMMAND');
      }
      this.applyUpdate(command.input.ExpressionAttributeValues ?? {});
      return {};
    });
  }

  private applyUpdate(values: Record<string, unknown>): void {
    if (this.item === undefined) throw new Error('UNEXPECTED_DYNAMO_COMMAND');
    if (values[':claimed'] !== undefined) {
      this.item.executionStatus = 'claimed';
      this.item.claimOwner = values[':claimOwner'];
      this.item.claimEpoch = values[':nextClaimEpoch'];
      this.item.claimExpiresAtEpochMs = values[':leaseExpiresAtEpochMs'];
    } else if (values[':dispatching'] !== undefined) {
      this.item.executionStatus = 'dispatching';
      this.item.dispatchAttempt = values[':dispatchAttempt'];
      this.item.attemptCount = values[':nextAttemptCount'];
    } else if (values[':settled'] !== undefined) {
      this.item.executionStatus = 'settled';
      this.item.executionOutcome = values[':executionOutcome'];
      this.item.effectDisabledReceipt = values[':effectDisabledReceipt'];
      this.item.settledAt = values[':settledAt'];
      delete this.item.claimOwner;
      delete this.item.claimExpiresAtEpochMs;
    } else {
      throw new Error('UNEXPECTED_EXECUTION_UPDATE');
    }
    this.item.stateVersion = values[':nextStateVersion'];
  }
}

function item(): DynamoApprovalExecutionRecords {
  return buildDynamoApprovalExecutionRecords({
    state: authoritativeState(),
    createdAt: NOW,
  });
}

function event(operationId = 'operation-send-001' as OperationId) {
  return {
    Records: [
      {
        messageId: 'sqs-message-001',
        body: JSON.stringify({ operationId }),
      },
    ],
  };
}

describe('AWS effect-disabled execution composition', () => {
  it('proves approved immutable operation -> SQS -> claim/guard -> effect-disabled receipt', async () => {
    const store = new CompositionDynamoStore(item());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const handler = createAwsEffectDisabledExecutionHandler(ENVIRONMENT, {
      documentClient: store as never,
      now: () => RUN_AT,
    });

    await expect(handler(event())).resolves.toEqual({ batchItemFailures: [] });
    expect(store.item).toMatchObject({
      executionStatus: 'settled',
      executionOutcome: 'effect_disabled',
      effectDisabledReceipt: {
        kind: 'effect_disabled',
        operationId: 'operation-send-001',
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      store.commands.some((command) => command instanceof GetCommand),
    ).toBe(true);
    expect(
      store.commands.some((command) => command instanceof TransactGetCommand),
    ).toBe(true);
    expect(
      store.commands.some((command) => command instanceof UpdateCommand),
    ).toBe(true);

    await expect(handler(event())).resolves.toEqual({ batchItemFailures: [] });
    expect(store.item?.attemptCount).toBe(1);
  });

  it('returns missing authoritative records and malformed messages as per-record failures', async () => {
    const missingStore = new CompositionDynamoStore();
    const missing = createAwsEffectDisabledExecutionHandler(ENVIRONMENT, {
      documentClient: missingStore as never,
      now: () => RUN_AT,
    });
    await expect(missing(event())).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'sqs-message-001' }],
    });

    const malformedStore = new CompositionDynamoStore(item());
    const malformed = createAwsEffectDisabledExecutionHandler(ENVIRONMENT, {
      documentClient: malformedStore as never,
      now: () => RUN_AT,
    });
    await expect(
      malformed({
        Records: [
          { messageId: 'poison-json', body: '{not-json' },
          {
            messageId: 'smuggled-authority',
            body: JSON.stringify({
              operationId: 'operation-send-001',
              tenantId: 'tenant-attacker',
            }),
          },
        ],
      }),
    ).resolves.toEqual({
      batchItemFailures: [
        { itemIdentifier: 'poison-json' },
        { itemIdentifier: 'smuggled-authority' },
      ],
    });
    expect(malformedStore.commands).toHaveLength(0);
  });

  it('fails every record closed when module configuration is missing or malformed', async () => {
    const missing = createProductionExecutionModuleHandler({ environment: {} });
    await expect(missing(event())).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'sqs-message-001' }],
    });

    const malformed = createProductionExecutionModuleHandler({
      environment: { ...ENVIRONMENT, PROVIDER_EFFECTS: 'enabled' },
    });
    await expect(malformed(event())).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'sqs-message-001' }],
    });
  });
});
