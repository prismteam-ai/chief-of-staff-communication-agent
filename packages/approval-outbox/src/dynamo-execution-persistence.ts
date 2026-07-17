import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactGetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  actionPlanSchema,
  approvalSchema,
  clientCorrelationSchema,
  contactChannelPolicySchema,
  effectExecutionArtifactSchema,
  outboxItemSchema,
  providerSendResultSchema,
  type EffectExecutionArtifact,
  type ProviderSendResult,
} from '@chief/contracts/approval';
import {
  connectorAccountRefSchema,
  connectorSnapshotSchema,
} from '@chief/contracts/connectors';
import {
  accountIdSchema,
  attemptIdSchema,
  brandIdSchema,
  draftRevisionIdSchema,
  keyedDigestValueSchema,
  messageRevisionIdSchema,
  operationIdSchema,
  sha256Schema,
  tenantIdSchema,
  timestampSchema,
  type OperationId,
} from '@chief/contracts/ids';

import type {
  ContactPolicyBinding,
  EffectSwitchBinding,
  ImmutableOperationRecord,
  OperationApprovalBinding,
} from './approval-service.js';
import { canonicalSha256, immutable } from './canonical.js';
import type {
  ApprovalExecutionPersistence,
  AuthoritativeExecutionState,
  EffectDisabledReceipt,
  OperationClaim,
  OperationClaimResult,
} from './execution-service.js';

const MAX_RECORD_BYTES = 320 * 1_024;
const MAX_PROVIDER_RESULT_BYTES = 4 * 1_024;
const MAX_PROVIDER_CORRELATION_BYTES = 1 * 1_024;
const SAFE_REASON_CODE = /^[A-Za-z0-9_]{1,96}$/u;
type DynamoTransactionUpdate = NonNullable<
  NonNullable<
    ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
  >[number]['Update']
>;

export interface DynamoApprovalExecutionPersistenceOptions {
  readonly client: DynamoDBDocumentClient;
  readonly coreTableName: string;
  readonly now?: () => string;
}

export type ApprovalExecutionImmutableState = Pick<
  AuthoritativeExecutionState,
  'actionPlan' | 'approval' | 'operation'
>;

export type ApprovalExecutionCurrentAuthority = Pick<
  AuthoritativeExecutionState,
  | 'currentSourceMessageRevisionId'
  | 'approverAuthorityActive'
  | 'connector'
  | 'contactPolicies'
  | 'effectSwitch'
>;

export interface DynamoApprovalExecutionItem {
  readonly PK: string;
  readonly SK: string;
  readonly entityType: 'approval_execution';
  readonly schemaVersion: '1';
  readonly tenantId: string;
  readonly operationId: string;
  readonly artifactHash: string;
  readonly stableIdempotencyKey: string;
  readonly executionStatus: 'ready';
  readonly claimEpoch: 0;
  readonly attemptCount: 0;
  readonly stateVersion: 1;
  readonly authorityVersion: 1;
  readonly immutableState: ApprovalExecutionImmutableState;
  readonly createdAt: string;
}

export interface DynamoApprovalExecutionAuthorityItem {
  readonly PK: string;
  readonly SK: string;
  readonly entityType: 'approval_execution_authority';
  readonly schemaVersion: '1';
  readonly tenantId: string;
  readonly operationId: string;
  readonly authorityVersion: 1;
  readonly currentAuthority: ApprovalExecutionCurrentAuthority;
  readonly updatedAt: string;
}

export interface DynamoApprovalExecutionLocatorItem {
  readonly PK: string;
  readonly SK: string;
  readonly entityType: 'approval_execution_locator';
  readonly schemaVersion: '1';
  readonly tenantId: string;
  readonly operationId: string;
  readonly aggregatePK: string;
  readonly aggregateSK: string;
  readonly authorityPK: string;
  readonly authoritySK: string;
  readonly createdAt: string;
}

export interface DynamoApprovalExecutionRecords {
  readonly aggregate: DynamoApprovalExecutionItem;
  readonly authority: DynamoApprovalExecutionAuthorityItem;
  readonly locator: DynamoApprovalExecutionLocatorItem;
}

interface LocatedRecord {
  readonly route: Readonly<{ PK: string; SK: string }>;
  readonly item: Readonly<Record<string, unknown>>;
  readonly authorityRoute: Readonly<{ PK: string; SK: string }>;
  readonly authorityItem: Readonly<Record<string, unknown>>;
  readonly authorityVersion: number;
  readonly authoritativeState: AuthoritativeExecutionState;
}

interface MutableClaimContext {
  readonly route: Readonly<{ PK: string; SK: string }>;
  readonly tenantId: string;
  readonly operationId: OperationId;
  readonly artifactHash: string;
  readonly stableIdempotencyKey: string;
  authorityVersion?: number;
  stateVersion: number;
  attemptCount: number;
  status: 'claimed' | 'dispatching';
}

interface RecordMetadata {
  readonly tenantId: string;
  readonly operationId: OperationId;
  readonly artifactHash: string;
  readonly stableIdempotencyKey: string;
  readonly executionStatus:
    | 'ready'
    | 'claimed'
    | 'dispatching'
    | 'settled'
    | 'reconciliation_required'
    | 'frozen'
    | 'blocked';
  readonly claimEpoch: number;
  readonly claimOwner?: string;
  readonly claimExpiresAtEpochMs?: number;
  readonly attemptCount: number;
  readonly stateVersion: number;
}

class ConditionalRaceError extends Error {
  public constructor() {
    super('DYNAMO_EXECUTION_CONDITIONAL_RACE');
    this.name = 'ConditionalRaceError';
  }
}

function recordValue(
  value: unknown,
  code = 'MALFORMED_APPROVAL_EXECUTION_RECORD',
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringValue(
  value: unknown,
  code = 'MALFORMED_APPROVAL_EXECUTION_RECORD',
): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean')
    throw new Error('MALFORMED_APPROVAL_EXECUTION_RECORD');
  return value;
}

function integerValue(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error('MALFORMED_APPROVAL_EXECUTION_RECORD');
  }
  return value as number;
}

function optionalInteger(value: unknown, minimum: number): number | undefined {
  return value === undefined ? undefined : integerValue(value, minimum);
}

function arrayValue(value: unknown): readonly unknown[] {
  if (!Array.isArray(value))
    throw new Error('MALFORMED_APPROVAL_EXECUTION_RECORD');
  return value;
}

function encodeInternalId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/u.test(value)) {
    throw new Error('INVALID_INTERNAL_EXECUTION_IDENTIFIER');
  }
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function approvalExecutionKey(
  tenantId: string,
  operationId: string,
): Readonly<{ PK: string; SK: string }> {
  return Object.freeze({
    PK: `T#${encodeInternalId(tenantId)}`,
    SK: `E#${encodeInternalId('approval-execution')}#${encodeInternalId(operationId)}`,
  });
}

export function approvalExecutionLookupKey(operationId: string): string {
  return `O#${encodeInternalId(operationId)}`;
}

export function approvalExecutionLocatorKey(
  operationId: string,
): Readonly<{ PK: string; SK: string }> {
  return Object.freeze({
    PK: approvalExecutionLookupKey(operationId),
    SK: `L#${encodeInternalId('approval-execution')}`,
  });
}

export function approvalExecutionAuthorityKey(
  tenantId: string,
  operationId: string,
): Readonly<{ PK: string; SK: string }> {
  return Object.freeze({
    PK: `T#${encodeInternalId(tenantId)}`,
    SK: `A#${encodeInternalId('approval-execution-authority')}#${encodeInternalId(operationId)}`,
  });
}

function parseEffectSwitch(value: unknown): EffectSwitchBinding {
  const input = recordValue(value);
  const policy = stringValue(input.policy);
  if (policy !== 'effect_disabled' && policy !== 'external_effect') {
    throw new Error('MALFORMED_APPROVAL_EXECUTION_RECORD');
  }
  return immutable({
    globalVersion: integerValue(input.globalVersion, 1),
    accountVersion: integerValue(input.accountVersion, 1),
    operationVersion: integerValue(input.operationVersion, 1),
    policy,
  });
}

function parseContactBinding(value: unknown): ContactPolicyBinding {
  const input = recordValue(value);
  return immutable({
    tenantId: tenantIdSchema.parse(input.tenantId),
    contactIdentityDigest: keyedDigestValueSchema.parse(
      input.contactIdentityDigest,
    ),
    channel: stringValue(input.channel),
    connectorAccountId: accountIdSchema.parse(input.connectorAccountId),
    brandId: brandIdSchema.parse(input.brandId),
    projectionVersion: integerValue(input.projectionVersion, 1),
  });
}

function parseOperationBinding(value: unknown): OperationApprovalBinding {
  const input = recordValue(value);
  const draftRevisionId =
    input.draftRevisionId === undefined
      ? undefined
      : draftRevisionIdSchema.parse(input.draftRevisionId);
  return immutable({
    operationId: operationIdSchema.parse(input.operationId),
    attemptId: attemptIdSchema.parse(input.attemptId),
    account: connectorAccountRefSchema.parse(input.account),
    connectorSnapshot: connectorSnapshotSchema.parse(input.connectorSnapshot),
    renderedPayloadFingerprint: sha256Schema.parse(
      input.renderedPayloadFingerprint,
    ),
    ...(draftRevisionId === undefined ? {} : { draftRevisionId }),
    clientCorrelation: clientCorrelationSchema.parse(input.clientCorrelation),
    correlationBindingVersion: stringValue(input.correlationBindingVersion),
    reconciliationStrategy: stringValue(input.reconciliationStrategy),
    reconciliationStrategyVersion: stringValue(
      input.reconciliationStrategyVersion,
    ),
    contactPolicies: immutable(
      arrayValue(input.contactPolicies).map(parseContactBinding),
    ),
    effectSwitch: parseEffectSwitch(input.effectSwitch),
  });
}

function parseImmutableOperation(value: unknown): ImmutableOperationRecord {
  const input = recordValue(value);
  const outboxItem = outboxItemSchema.parse(input.outboxItem);
  const artifact = effectExecutionArtifactSchema.parse(input.artifact);
  const binding = parseOperationBinding(input.binding);
  const artifactHash = sha256Schema.parse(input.artifactHash);
  if (
    canonicalSha256(artifact) !== artifactHash ||
    outboxItem.operationId !== artifact.operationId ||
    outboxItem.stableIdempotencyKey !== artifact.stableIdempotencyKey ||
    binding.operationId !== artifact.operationId ||
    binding.attemptId !== artifact.attemptId ||
    binding.account.tenantId !== artifact.account.tenantId ||
    binding.account.accountId !== artifact.account.accountId ||
    binding.account.expectedStateVersion !==
      artifact.account.expectedStateVersion ||
    binding.renderedPayloadFingerprint !==
      artifact.renderedPayloadFingerprint ||
    binding.connectorSnapshot.capabilitySnapshotHash !==
      artifact.connectorSnapshot.capabilitySnapshotHash
  ) {
    throw new Error('MALFORMED_APPROVAL_EXECUTION_RECORD');
  }
  return immutable({ outboxItem, artifact, binding, artifactHash });
}

function parseCurrentEffectSwitch(
  value: unknown,
): AuthoritativeExecutionState['effectSwitch'] {
  const input = recordValue(value);
  return immutable({
    ...parseEffectSwitch(input),
    globalEnabled: booleanValue(input.globalEnabled),
    accountEnabled: booleanValue(input.accountEnabled),
    operationEnabled: booleanValue(input.operationEnabled),
  });
}

function parseCurrentAuthorityState(
  value: unknown,
): ApprovalExecutionCurrentAuthority {
  const currentAuthority = recordValue(value);
  const connectorInput = recordValue(currentAuthority.connector);
  const connectorStatus = stringValue(connectorInput.status);
  const connectorHealth = stringValue(connectorInput.health);
  if (
    !['pending', 'active', 'degraded', 'revoked', 'disabled'].includes(
      connectorStatus,
    ) ||
    !['unknown', 'healthy', 'degraded', 'failed'].includes(connectorHealth)
  ) {
    throw new Error('MALFORMED_APPROVAL_EXECUTION_RECORD');
  }
  return immutable({
    currentSourceMessageRevisionId: messageRevisionIdSchema.parse(
      currentAuthority.currentSourceMessageRevisionId,
    ),
    approverAuthorityActive: booleanValue(
      currentAuthority.approverAuthorityActive,
    ),
    connector: {
      accountId: accountIdSchema.parse(connectorInput.accountId),
      stateVersion: integerValue(connectorInput.stateVersion, 1),
      status:
        connectorStatus as AuthoritativeExecutionState['connector']['status'],
      health:
        connectorHealth as AuthoritativeExecutionState['connector']['health'],
      snapshot: connectorSnapshotSchema.parse(connectorInput.snapshot),
      operationCapabilityEnabled: booleanValue(
        connectorInput.operationCapabilityEnabled,
      ),
    },
    contactPolicies: immutable(
      arrayValue(currentAuthority.contactPolicies).map((policy) =>
        contactChannelPolicySchema.parse(policy),
      ),
    ),
    effectSwitch: parseCurrentEffectSwitch(currentAuthority.effectSwitch),
  });
}

function hydrateAuthoritativeState(
  item: Readonly<Record<string, unknown>>,
  authorityItem: Readonly<Record<string, unknown>>,
): Readonly<{
  state: AuthoritativeExecutionState;
  authorityVersion: number;
}> {
  const serialized = JSON.stringify([item, authorityItem]);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
    throw new Error('APPROVAL_EXECUTION_RECORD_TOO_LARGE');
  }
  const immutableState = recordValue(item.immutableState);
  const currentAuthority = parseCurrentAuthorityState(
    authorityItem.currentAuthority,
  );
  const actionPlan = actionPlanSchema.parse(immutableState.actionPlan);
  const approval = approvalSchema.parse(immutableState.approval);
  const operation = parseImmutableOperation(immutableState.operation);
  const authoritative: AuthoritativeExecutionState = immutable({
    actionPlan,
    approval,
    operation,
    ...currentAuthority,
  });
  const tenantId = tenantIdSchema.parse(item.tenantId);
  const operationId = operationIdSchema.parse(item.operationId);
  const key = approvalExecutionKey(tenantId, operationId);
  const authorityKey = approvalExecutionAuthorityKey(tenantId, operationId);
  const authorityVersion = integerValue(authorityItem.authorityVersion, 1);
  if (
    item.entityType !== 'approval_execution' ||
    item.schemaVersion !== '1' ||
    item.PK !== key.PK ||
    item.SK !== key.SK ||
    authorityItem.entityType !== 'approval_execution_authority' ||
    authorityItem.schemaVersion !== '1' ||
    authorityItem.PK !== authorityKey.PK ||
    authorityItem.SK !== authorityKey.SK ||
    authorityItem.tenantId !== tenantId ||
    authorityItem.operationId !== operationId ||
    item.authorityVersion !== authorityVersion ||
    actionPlan.tenantId !== tenantId ||
    approval.tenantId !== tenantId ||
    operation.artifact.tenantId !== tenantId ||
    operation.artifact.operationId !== operationId ||
    item.artifactHash !== operation.artifactHash ||
    item.stableIdempotencyKey !== operation.artifact.stableIdempotencyKey
  ) {
    throw new Error('MALFORMED_APPROVAL_EXECUTION_RECORD');
  }
  return immutable({ state: authoritative, authorityVersion });
}

function parseMetadata(
  item: Readonly<Record<string, unknown>>,
): RecordMetadata {
  const executionStatus = stringValue(item.executionStatus);
  if (
    ![
      'ready',
      'claimed',
      'dispatching',
      'settled',
      'reconciliation_required',
      'frozen',
      'blocked',
    ].includes(executionStatus)
  ) {
    throw new Error('MALFORMED_APPROVAL_EXECUTION_RECORD');
  }
  return {
    tenantId: tenantIdSchema.parse(item.tenantId),
    operationId: operationIdSchema.parse(item.operationId),
    artifactHash: sha256Schema.parse(item.artifactHash),
    stableIdempotencyKey: stringValue(item.stableIdempotencyKey),
    executionStatus: executionStatus as RecordMetadata['executionStatus'],
    claimEpoch: integerValue(item.claimEpoch, 0),
    ...(item.claimOwner === undefined
      ? {}
      : { claimOwner: stringValue(item.claimOwner) }),
    ...(item.claimExpiresAtEpochMs === undefined
      ? {}
      : {
          claimExpiresAtEpochMs: optionalInteger(item.claimExpiresAtEpochMs, 0),
        }),
    attemptCount: integerValue(item.attemptCount, 0),
    stateVersion: integerValue(item.stateVersion, 1),
  };
}

export function buildDynamoApprovalExecutionRecords(input: {
  readonly state: AuthoritativeExecutionState;
  readonly createdAt: string;
}): DynamoApprovalExecutionRecords {
  const createdAt = timestampSchema.parse(input.createdAt);
  if (input.state.operation.outboxItem.status !== 'ready') {
    throw new Error('APPROVAL_EXECUTION_ITEM_MUST_START_READY');
  }
  const tenantId = input.state.actionPlan.tenantId;
  const operationId = input.state.operation.artifact.operationId;
  const key = approvalExecutionKey(tenantId, operationId);
  const authorityKey = approvalExecutionAuthorityKey(tenantId, operationId);
  const locatorKey = approvalExecutionLocatorKey(operationId);
  const aggregate = immutable({
    ...key,
    entityType: 'approval_execution' as const,
    schemaVersion: '1' as const,
    tenantId,
    operationId,
    artifactHash: input.state.operation.artifactHash,
    stableIdempotencyKey: input.state.operation.artifact.stableIdempotencyKey,
    executionStatus: 'ready' as const,
    claimEpoch: 0 as const,
    attemptCount: 0 as const,
    stateVersion: 1 as const,
    authorityVersion: 1 as const,
    immutableState: immutable({
      actionPlan: input.state.actionPlan,
      approval: input.state.approval,
      operation: input.state.operation,
    }),
    createdAt,
  });
  const authority = immutable({
    ...authorityKey,
    entityType: 'approval_execution_authority' as const,
    schemaVersion: '1' as const,
    tenantId,
    operationId,
    authorityVersion: 1 as const,
    currentAuthority: parseCurrentAuthorityState(input.state),
    updatedAt: createdAt,
  });
  const locator = immutable({
    ...locatorKey,
    entityType: 'approval_execution_locator' as const,
    schemaVersion: '1' as const,
    tenantId,
    operationId,
    aggregatePK: key.PK,
    aggregateSK: key.SK,
    authorityPK: authorityKey.PK,
    authoritySK: authorityKey.SK,
    createdAt,
  });
  hydrateAuthoritativeState(aggregate, authority);
  return immutable({ aggregate, authority, locator });
}

export function buildDynamoApprovalExecutionCreateTransaction(input: {
  readonly tableName: string;
  readonly state: AuthoritativeExecutionState;
  readonly createdAt: string;
}): ConstructorParameters<typeof TransactWriteCommand>[0] {
  const tableName = stringValue(
    input.tableName.trim(),
    'INVALID_CORE_TABLE_NAME',
  );
  const records = buildDynamoApprovalExecutionRecords(input);
  return {
    TransactItems: [records.locator, records.aggregate, records.authority].map(
      (Item) => ({
        Put: {
          TableName: tableName,
          Item,
          ConditionExpression:
            'attribute_not_exists(PK) AND attribute_not_exists(SK)',
        },
      }),
    ),
  };
}

export function buildDynamoApprovalExecutionAuthorityUpdateTransaction(input: {
  readonly tableName: string;
  readonly tenantId: string;
  readonly operationId: string;
  readonly expectedAuthorityVersion: number;
  readonly currentAuthority: ApprovalExecutionCurrentAuthority;
  readonly updatedAt: string;
}): ConstructorParameters<typeof TransactWriteCommand>[0] {
  const tableName = stringValue(
    input.tableName.trim(),
    'INVALID_CORE_TABLE_NAME',
  );
  const tenantId = tenantIdSchema.parse(input.tenantId);
  const operationId = operationIdSchema.parse(input.operationId);
  const expectedAuthorityVersion = integerValue(
    input.expectedAuthorityVersion,
    1,
  );
  const currentAuthority = parseCurrentAuthorityState(input.currentAuthority);
  const updatedAt = timestampSchema.parse(input.updatedAt);
  const authorityKey = approvalExecutionAuthorityKey(tenantId, operationId);
  return {
    TransactItems: [
      {
        ConditionCheck: {
          TableName: tableName,
          Key: approvalExecutionLocatorKey(operationId),
          ConditionExpression:
            '#entityType = :locatorType AND #tenantId = :tenantId AND #operationId = :operationId AND #authorityPK = :authorityPK AND #authoritySK = :authoritySK',
          ExpressionAttributeNames: {
            '#entityType': 'entityType',
            '#tenantId': 'tenantId',
            '#operationId': 'operationId',
            '#authorityPK': 'authorityPK',
            '#authoritySK': 'authoritySK',
          },
          ExpressionAttributeValues: {
            ':locatorType': 'approval_execution_locator',
            ':tenantId': tenantId,
            ':operationId': operationId,
            ':authorityPK': authorityKey.PK,
            ':authoritySK': authorityKey.SK,
          },
        },
      },
      {
        Update: {
          TableName: tableName,
          Key: authorityKey,
          ConditionExpression:
            '#entityType = :authorityType AND #tenantId = :tenantId AND #operationId = :operationId AND #authorityVersion = :expectedAuthorityVersion',
          UpdateExpression:
            'SET #currentAuthority = :currentAuthority, #authorityVersion = :nextAuthorityVersion, #updatedAt = :updatedAt',
          ExpressionAttributeNames: {
            '#entityType': 'entityType',
            '#tenantId': 'tenantId',
            '#operationId': 'operationId',
            '#authorityVersion': 'authorityVersion',
            '#currentAuthority': 'currentAuthority',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':authorityType': 'approval_execution_authority',
            ':tenantId': tenantId,
            ':operationId': operationId,
            ':expectedAuthorityVersion': expectedAuthorityVersion,
            ':nextAuthorityVersion': expectedAuthorityVersion + 1,
            ':currentAuthority': currentAuthority,
            ':updatedAt': updatedAt,
          },
        },
      },
      {
        Update: {
          TableName: tableName,
          Key: approvalExecutionKey(tenantId, operationId),
          ConditionExpression:
            '#entityType = :aggregateType AND #tenantId = :tenantId AND #operationId = :operationId AND #authorityVersion = :expectedAuthorityVersion',
          UpdateExpression: 'SET #authorityVersion = :nextAuthorityVersion',
          ExpressionAttributeNames: {
            '#entityType': 'entityType',
            '#tenantId': 'tenantId',
            '#operationId': 'operationId',
            '#authorityVersion': 'authorityVersion',
          },
          ExpressionAttributeValues: {
            ':aggregateType': 'approval_execution',
            ':tenantId': tenantId,
            ':operationId': operationId,
            ':expectedAuthorityVersion': expectedAuthorityVersion,
            ':nextAuthorityVersion': expectedAuthorityVersion + 1,
          },
        },
      },
    ],
  };
}

function isConditionalFailure(error: unknown): boolean {
  return (
    error instanceof ConditionalCheckFailedException ||
    (error !== null &&
      typeof error === 'object' &&
      'name' in error &&
      (error.name === 'ConditionalCheckFailedException' ||
        error.name === 'TransactionCanceledException'))
  );
}

function safeReasonCode(value: string, fallback: string): string {
  return SAFE_REASON_CODE.test(value) ? value : fallback;
}

function assertBoundedProviderResult(
  result: Readonly<Record<string, unknown>>,
): void {
  if (
    Buffer.byteLength(JSON.stringify(result), 'utf8') >
    MAX_PROVIDER_RESULT_BYTES
  ) {
    throw new Error('PROVIDER_RESULT_EXCEEDS_PERSISTENCE_LIMIT');
  }
}

export class DynamoApprovalExecutionAuthorityProjectionWriter {
  readonly #client: DynamoDBDocumentClient;
  readonly #coreTableName: string;

  public constructor(input: {
    readonly client: DynamoDBDocumentClient;
    readonly coreTableName: string;
  }) {
    this.#client = input.client;
    this.#coreTableName = stringValue(
      input.coreTableName.trim(),
      'INVALID_CORE_TABLE_NAME',
    );
  }

  public async update(
    input: Omit<
      Parameters<
        typeof buildDynamoApprovalExecutionAuthorityUpdateTransaction
      >[0],
      'tableName'
    >,
  ): Promise<void> {
    try {
      await this.#client.send(
        new TransactWriteCommand(
          buildDynamoApprovalExecutionAuthorityUpdateTransaction({
            ...input,
            tableName: this.#coreTableName,
          }),
        ),
      );
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new Error('AUTHORITY_PROJECTION_CONDITIONAL_RACE', {
          cause: error,
        });
      }
      throw error;
    }
  }
}

export class DynamoApprovalExecutionPersistence implements ApprovalExecutionPersistence {
  readonly #client: DynamoDBDocumentClient;
  readonly #coreTableName: string;
  readonly #now: () => string;
  readonly #claimContexts = new WeakMap<OperationClaim, MutableClaimContext>();
  readonly #activeClaims = new Map<OperationId, MutableClaimContext>();

  public constructor(options: DynamoApprovalExecutionPersistenceOptions) {
    this.#client = options.client;
    this.#coreTableName = stringValue(
      options.coreTableName.trim(),
      'INVALID_CORE_TABLE_NAME',
    );
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public async claimOperation(input: {
    readonly operationId: OperationId;
    readonly claimOwner: string;
    readonly now: string;
    readonly leaseDurationMs: number;
  }): Promise<OperationClaimResult> {
    const operationId = operationIdSchema.parse(input.operationId);
    const claimOwner = stringValue(input.claimOwner, 'INVALID_CLAIM_OWNER');
    const now = timestampSchema.parse(input.now);
    const nowEpochMs = Date.parse(now);
    if (
      claimOwner.length > 200 ||
      !Number.isSafeInteger(input.leaseDurationMs) ||
      input.leaseDurationMs < 1_000 ||
      input.leaseDurationMs > 15 * 60_000
    ) {
      throw new Error('INVALID_OPERATION_CLAIM');
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const located = await this.#locate(operationId);
      if (located === undefined) {
        throw new Error('AUTHORITATIVE_EXECUTION_STATE_NOT_FOUND');
      }
      const metadata = parseMetadata(located.item);
      if (metadata.operationId !== operationId) {
        throw new Error('EXECUTION_OPERATION_LOCATOR_MISMATCH');
      }
      if (
        metadata.executionStatus === 'settled' ||
        metadata.executionStatus === 'blocked'
      ) {
        return { status: 'duplicate' };
      }
      if (
        metadata.executionStatus === 'reconciliation_required' ||
        metadata.executionStatus === 'frozen'
      ) {
        return { status: 'frozen' };
      }
      if (metadata.executionStatus === 'dispatching') {
        if (
          metadata.claimExpiresAtEpochMs === undefined ||
          metadata.claimOwner === undefined
        ) {
          throw new Error('MALFORMED_APPROVAL_EXECUTION_RECORD');
        }
        if (metadata.claimExpiresAtEpochMs >= nowEpochMs) {
          return { status: 'contended' };
        }
        try {
          await this.#freezeExpiredDispatch(
            located.route,
            metadata,
            nowEpochMs,
          );
          return { status: 'frozen' };
        } catch (error) {
          if (error instanceof ConditionalRaceError) continue;
          throw error;
        }
      }
      if (metadata.executionStatus === 'claimed') {
        if (
          metadata.claimExpiresAtEpochMs === undefined ||
          metadata.claimOwner === undefined
        ) {
          throw new Error('MALFORMED_APPROVAL_EXECUTION_RECORD');
        }
        if (metadata.claimExpiresAtEpochMs >= nowEpochMs) {
          return { status: 'contended' };
        }
      }

      const nextClaimEpoch = metadata.claimEpoch + 1;
      const nextStateVersion = metadata.stateVersion + 1;
      const leaseExpiresAtEpochMs = nowEpochMs + input.leaseDurationMs;
      try {
        await this.#update({
          TableName: this.#coreTableName,
          Key: located.route,
          ConditionExpression:
            '#tenantId = :tenantId AND #operationId = :operationId AND #executionStatus = :expectedStatus AND #claimEpoch = :expectedClaimEpoch AND #stateVersion = :expectedStateVersion AND #artifactHash = :artifactHash' +
            (metadata.executionStatus === 'claimed'
              ? ' AND #claimExpiresAtEpochMs < :nowEpochMs'
              : ''),
          UpdateExpression:
            'SET #executionStatus = :claimed, #claimOwner = :claimOwner, #claimEpoch = :nextClaimEpoch, #claimExpiresAtEpochMs = :leaseExpiresAtEpochMs, #stateVersion = :nextStateVersion',
          ExpressionAttributeNames: {
            '#tenantId': 'tenantId',
            '#operationId': 'operationId',
            '#executionStatus': 'executionStatus',
            '#claimOwner': 'claimOwner',
            '#claimEpoch': 'claimEpoch',
            '#claimExpiresAtEpochMs': 'claimExpiresAtEpochMs',
            '#stateVersion': 'stateVersion',
            '#artifactHash': 'artifactHash',
          },
          ExpressionAttributeValues: {
            ':tenantId': metadata.tenantId,
            ':operationId': operationId,
            ':expectedStatus': metadata.executionStatus,
            ':claimed': 'claimed',
            ':claimOwner': claimOwner,
            ':expectedClaimEpoch': metadata.claimEpoch,
            ':nextClaimEpoch': nextClaimEpoch,
            ':leaseExpiresAtEpochMs': leaseExpiresAtEpochMs,
            ':expectedStateVersion': metadata.stateVersion,
            ':nextStateVersion': nextStateVersion,
            ':artifactHash': metadata.artifactHash,
            ...(metadata.executionStatus === 'claimed'
              ? { ':nowEpochMs': nowEpochMs }
              : {}),
          },
        });
      } catch (error) {
        if (error instanceof ConditionalRaceError) continue;
        throw error;
      }
      const claim = immutable({
        operationId,
        claimOwner,
        claimEpoch: nextClaimEpoch,
        leaseExpiresAt: new Date(leaseExpiresAtEpochMs).toISOString(),
      });
      const context: MutableClaimContext = {
        route: located.route,
        tenantId: metadata.tenantId,
        operationId,
        artifactHash: metadata.artifactHash,
        stableIdempotencyKey: metadata.stableIdempotencyKey,
        stateVersion: nextStateVersion,
        attemptCount: metadata.attemptCount,
        status: 'claimed',
      };
      this.#claimContexts.set(claim, context);
      this.#activeClaims.set(operationId, context);
      return { status: 'claimed', claim };
    }
    return { status: 'contended' };
  }

  public async loadAuthoritativeState(
    operationId: OperationId,
  ): Promise<AuthoritativeExecutionState | undefined> {
    const parsedOperationId = operationIdSchema.parse(operationId);
    const located = await this.#locate(parsedOperationId);
    if (located === undefined) return undefined;
    const context = this.#activeClaims.get(parsedOperationId);
    if (context !== undefined && context.route.PK === located.route.PK) {
      context.authorityVersion = located.authorityVersion;
    }
    return located.authoritativeState;
  }

  public async releaseUncalledClaim(claim: OperationClaim): Promise<void> {
    const context = this.#claimContext(claim, 'claimed');
    await this.#updateClaim(
      claim,
      context,
      'SET #executionStatus = :ready, #stateVersion = :nextStateVersion REMOVE #claimOwner, #claimExpiresAtEpochMs',
      { ':ready': 'ready' },
    );
    this.#forgetClaim(claim, context);
  }

  public async persistDispatchAttempt(
    claim: OperationClaim,
    artifact: EffectExecutionArtifact,
  ): Promise<void> {
    const context = this.#claimContext(claim, 'claimed');
    const parsedArtifact = effectExecutionArtifactSchema.parse(artifact);
    if (
      parsedArtifact.operationId !== claim.operationId ||
      canonicalSha256(parsedArtifact) !== context.artifactHash ||
      parsedArtifact.stableIdempotencyKey !== context.stableIdempotencyKey
    ) {
      throw new Error('IMMUTABLE_EFFECT_ARTIFACT_MISMATCH');
    }
    const attemptedAt = timestampSchema.parse(this.#now());
    const attemptedAtEpochMs = Date.parse(attemptedAt);
    const nextAttemptCount = context.attemptCount + 1;
    if (context.authorityVersion === undefined) {
      throw new Error('AUTHORITATIVE_STATE_NOT_HYDRATED_FOR_DISPATCH');
    }
    await this.#updateClaim(
      claim,
      context,
      'SET #executionStatus = :dispatching, #dispatchAttempt = :dispatchAttempt, #attemptCount = :nextAttemptCount, #stateVersion = :nextStateVersion',
      {
        ':dispatching': 'dispatching',
        ':dispatchAttempt': immutable({
          schemaVersion: '1',
          operationId: parsedArtifact.operationId,
          attemptId: parsedArtifact.attemptId,
          artifactHash: context.artifactHash,
          stableIdempotencyKey: context.stableIdempotencyKey,
          claimOwner: claim.claimOwner,
          claimEpoch: claim.claimEpoch,
          attemptedAt,
        }),
        ':nextAttemptCount': nextAttemptCount,
        ':attemptedAtEpochMs': attemptedAtEpochMs,
        ':authorityVersion': context.authorityVersion,
      },
      ' AND attribute_not_exists(#dispatchAttempt) AND #claimExpiresAtEpochMs >= :attemptedAtEpochMs AND #authorityVersion = :authorityVersion',
      {
        '#dispatchAttempt': 'dispatchAttempt',
        '#attemptCount': 'attemptCount',
        '#authorityVersion': 'authorityVersion',
      },
    );
    context.attemptCount = nextAttemptCount;
    context.status = 'dispatching';
  }

  public async settleEffectDisabled(
    claim: OperationClaim,
    receipt: EffectDisabledReceipt,
  ): Promise<void> {
    const context = this.#claimContext(claim, 'dispatching');
    if (
      receipt.kind !== 'effect_disabled' ||
      receipt.operationId !== claim.operationId ||
      receipt.artifactHash !== context.artifactHash ||
      receipt.stableIdempotencyKey !== context.stableIdempotencyKey
    ) {
      throw new Error('EFFECT_DISABLED_RECEIPT_MISMATCH');
    }
    await this.#settleClaim(claim, context, {
      ':executionOutcome': 'effect_disabled',
      ':effectDisabledReceipt': immutable({
        ...receipt,
        observedAt: timestampSchema.parse(receipt.observedAt),
      }),
      ':settledAt': timestampSchema.parse(receipt.observedAt),
    });
  }

  public async settleRejected(
    claim: OperationClaim,
    result: Extract<ProviderSendResult, { readonly outcome: 'rejected' }>,
  ): Promise<void> {
    const context = this.#claimContext(claim, 'dispatching');
    const parsed = providerSendResultSchema.parse(result);
    if (parsed.outcome !== 'rejected')
      throw new Error('INVALID_REJECTED_RESULT');
    const bounded = immutable({
      ...parsed,
      reasonCode: safeReasonCode(parsed.reasonCode, 'PROVIDER_REJECTED'),
    });
    assertBoundedProviderResult(bounded);
    await this.#settleClaim(claim, context, {
      ':executionOutcome': 'provider_rejected',
      ':providerResult': bounded,
      ':settledAt': bounded.observedAt,
    });
  }

  public async settleAcceptedAndCorrelation(
    claim: OperationClaim,
    result: Extract<ProviderSendResult, { readonly outcome: 'accepted' }>,
  ): Promise<void> {
    const context = this.#claimContext(claim, 'dispatching');
    const parsed = providerSendResultSchema.parse(result);
    if (parsed.outcome !== 'accepted')
      throw new Error('INVALID_ACCEPTED_RESULT');
    if (
      Buffer.byteLength(parsed.providerCorrelation, 'utf8') >
      MAX_PROVIDER_CORRELATION_BYTES
    ) {
      throw new Error('PROVIDER_RESULT_EXCEEDS_PERSISTENCE_LIMIT');
    }
    assertBoundedProviderResult(parsed);
    await this.#settleClaim(
      claim,
      context,
      {
        ':executionOutcome': 'provider_accepted',
        ':providerResult': parsed,
        ':providerCorrelation': parsed.providerCorrelation,
        ':settledAt': parsed.observedAt,
      },
      ' AND attribute_not_exists(#providerCorrelation)',
      { '#providerCorrelation': 'providerCorrelation' },
    );
  }

  public async freezeAcceptanceUnknown(
    claim: OperationClaim,
    reasonCode: string,
    result?: Extract<
      ProviderSendResult,
      { readonly outcome: 'acceptance_unknown' }
    >,
  ): Promise<void> {
    const context = this.#claimContext(claim, 'dispatching');
    const parsed =
      result === undefined ? undefined : providerSendResultSchema.parse(result);
    if (parsed !== undefined && parsed.outcome !== 'acceptance_unknown') {
      throw new Error('INVALID_ACCEPTANCE_UNKNOWN_RESULT');
    }
    await this.#updateClaim(
      claim,
      context,
      'SET #executionStatus = :reconciliationRequired, #executionOutcome = :acceptanceUnknown, #reasonCode = :reasonCode, #retryDecision = :retryDenied, #acceptanceFrozenAt = :acceptanceFrozenAt, #stateVersion = :nextStateVersion' +
        (parsed?.providerResponseHash === undefined
          ? ''
          : ', #providerResponseHash = :providerResponseHash') +
        ' REMOVE #claimOwner, #claimExpiresAtEpochMs',
      {
        ':reconciliationRequired': 'reconciliation_required',
        ':acceptanceUnknown': 'acceptance_unknown',
        ':reasonCode': safeReasonCode(reasonCode, 'ACCEPTANCE_UNKNOWN'),
        ':retryDenied': 'retry_denied',
        ':acceptanceFrozenAt': timestampSchema.parse(
          parsed?.observedAt ?? this.#now(),
        ),
        ...(parsed?.providerResponseHash === undefined
          ? {}
          : { ':providerResponseHash': parsed.providerResponseHash }),
      },
      '',
      {
        '#executionOutcome': 'executionOutcome',
        '#reasonCode': 'reasonCode',
        '#retryDecision': 'retryDecision',
        '#acceptanceFrozenAt': 'acceptanceFrozenAt',
        ...(parsed?.providerResponseHash === undefined
          ? {}
          : { '#providerResponseHash': 'providerResponseHash' }),
      },
    );
    this.#forgetClaim(claim, context);
  }

  async #locate(operationId: OperationId): Promise<LocatedRecord | undefined> {
    const locatorKey = approvalExecutionLocatorKey(operationId);
    const locatorResponse = await this.#client.send(
      new GetCommand({
        TableName: this.#coreTableName,
        Key: locatorKey,
        ConsistentRead: true,
      }),
    );
    if (locatorResponse.Item === undefined) return undefined;
    const locator = recordValue(locatorResponse.Item);
    const tenantId = tenantIdSchema.parse(locator.tenantId);
    const route = approvalExecutionKey(tenantId, operationId);
    const authorityRoute = approvalExecutionAuthorityKey(tenantId, operationId);
    if (
      locator.entityType !== 'approval_execution_locator' ||
      locator.schemaVersion !== '1' ||
      locator.PK !== locatorKey.PK ||
      locator.SK !== locatorKey.SK ||
      locator.operationId !== operationId ||
      locator.aggregatePK !== route.PK ||
      locator.aggregateSK !== route.SK ||
      locator.authorityPK !== authorityRoute.PK ||
      locator.authoritySK !== authorityRoute.SK
    ) {
      throw new Error('EXECUTION_OPERATION_LOCATOR_MISMATCH');
    }
    const response = await this.#client.send(
      new TransactGetCommand({
        TransactItems: [
          { Get: { TableName: this.#coreTableName, Key: route } },
          { Get: { TableName: this.#coreTableName, Key: authorityRoute } },
        ],
      }),
    );
    const item = response.Responses?.[0]?.Item;
    const authorityItem = response.Responses?.[1]?.Item;
    if (item === undefined || authorityItem === undefined) return undefined;
    const parsedItem = recordValue(item);
    const parsedAuthorityItem = recordValue(authorityItem);
    const hydrated = hydrateAuthoritativeState(parsedItem, parsedAuthorityItem);
    return {
      route,
      item: parsedItem,
      authorityRoute,
      authorityItem: parsedAuthorityItem,
      authorityVersion: hydrated.authorityVersion,
      authoritativeState: hydrated.state,
    };
  }

  async #freezeExpiredDispatch(
    route: Readonly<{ PK: string; SK: string }>,
    metadata: RecordMetadata,
    observedAtEpochMs: number,
  ): Promise<void> {
    await this.#update({
      TableName: this.#coreTableName,
      Key: route,
      ConditionExpression:
        '#tenantId = :tenantId AND #operationId = :operationId AND #artifactHash = :artifactHash AND #executionStatus = :dispatching AND #claimOwner = :claimOwner AND #claimEpoch = :claimEpoch AND #claimExpiresAtEpochMs < :observedAtEpochMs AND #stateVersion = :expectedStateVersion',
      UpdateExpression:
        'SET #executionStatus = :reconciliationRequired, #executionOutcome = :acceptanceUnknown, #reasonCode = :reasonCode, #retryDecision = :retryDenied, #acceptanceFrozenAt = :acceptanceFrozenAt, #stateVersion = :nextStateVersion REMOVE #claimOwner, #claimExpiresAtEpochMs',
      ExpressionAttributeNames: {
        '#tenantId': 'tenantId',
        '#operationId': 'operationId',
        '#artifactHash': 'artifactHash',
        '#executionStatus': 'executionStatus',
        '#executionOutcome': 'executionOutcome',
        '#claimOwner': 'claimOwner',
        '#claimEpoch': 'claimEpoch',
        '#claimExpiresAtEpochMs': 'claimExpiresAtEpochMs',
        '#reasonCode': 'reasonCode',
        '#retryDecision': 'retryDecision',
        '#acceptanceFrozenAt': 'acceptanceFrozenAt',
        '#stateVersion': 'stateVersion',
      },
      ExpressionAttributeValues: {
        ':tenantId': metadata.tenantId,
        ':operationId': metadata.operationId,
        ':artifactHash': metadata.artifactHash,
        ':dispatching': 'dispatching',
        ':reconciliationRequired': 'reconciliation_required',
        ':acceptanceUnknown': 'acceptance_unknown',
        ':claimOwner': metadata.claimOwner,
        ':claimEpoch': metadata.claimEpoch,
        ':observedAtEpochMs': observedAtEpochMs,
        ':reasonCode': 'dispatch_lease_expired',
        ':retryDenied': 'retry_denied',
        ':acceptanceFrozenAt': new Date(observedAtEpochMs).toISOString(),
        ':expectedStateVersion': metadata.stateVersion,
        ':nextStateVersion': metadata.stateVersion + 1,
      },
    });
  }

  #claimContext(
    claim: OperationClaim,
    expectedStatus: MutableClaimContext['status'],
  ): MutableClaimContext {
    const context = this.#claimContexts.get(claim);
    if (
      context === undefined ||
      context.status !== expectedStatus ||
      context.operationId !== claim.operationId
    ) {
      throw new Error('STALE_OR_UNRECOGNIZED_OPERATION_CLAIM');
    }
    return context;
  }

  async #settleClaim(
    claim: OperationClaim,
    context: MutableClaimContext,
    values: Readonly<Record<string, unknown>>,
    extraCondition = '',
    extraNames: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    await this.#updateClaim(
      claim,
      context,
      'SET #executionStatus = :settled, #executionOutcome = :executionOutcome, #providerResult = :providerResult, #providerCorrelation = :providerCorrelation, #effectDisabledReceipt = :effectDisabledReceipt, #settledAt = :settledAt, #stateVersion = :nextStateVersion REMOVE #claimOwner, #claimExpiresAtEpochMs',
      {
        ':settled': 'settled',
        ':providerResult': null,
        ':providerCorrelation': null,
        ':effectDisabledReceipt': null,
        ...values,
      },
      extraCondition,
      {
        '#executionOutcome': 'executionOutcome',
        '#providerResult': 'providerResult',
        '#providerCorrelation': 'providerCorrelation',
        '#effectDisabledReceipt': 'effectDisabledReceipt',
        '#settledAt': 'settledAt',
        ...extraNames,
      },
    );
    this.#forgetClaim(claim, context);
  }

  async #updateClaim(
    claim: OperationClaim,
    context: MutableClaimContext,
    updateExpression: string,
    values: Readonly<Record<string, unknown>>,
    extraCondition = '',
    extraNames: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    const update = this.#claimUpdate(
      claim,
      context,
      updateExpression,
      values,
      extraCondition,
      extraNames,
    );
    await this.#update(update.input);
    context.stateVersion = update.nextStateVersion;
  }

  #claimUpdate(
    claim: OperationClaim,
    context: MutableClaimContext,
    updateExpression: string,
    values: Readonly<Record<string, unknown>>,
    extraCondition: string,
    extraNames: Readonly<Record<string, string>>,
  ): Readonly<{
    input: DynamoTransactionUpdate;
    nextStateVersion: number;
  }> {
    const nextStateVersion = context.stateVersion + 1;
    return {
      input: {
        TableName: this.#coreTableName,
        Key: context.route,
        ConditionExpression:
          '#tenantId = :tenantId AND #operationId = :operationId AND #executionStatus = :expectedStatus AND #claimOwner = :claimOwner AND #claimEpoch = :claimEpoch AND #stateVersion = :expectedStateVersion AND #artifactHash = :artifactHash' +
          extraCondition,
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: {
          '#tenantId': 'tenantId',
          '#operationId': 'operationId',
          '#executionStatus': 'executionStatus',
          '#claimOwner': 'claimOwner',
          '#claimEpoch': 'claimEpoch',
          ...(updateExpression.includes('#claimExpiresAtEpochMs') ||
          extraCondition.includes('#claimExpiresAtEpochMs')
            ? { '#claimExpiresAtEpochMs': 'claimExpiresAtEpochMs' }
            : {}),
          '#stateVersion': 'stateVersion',
          '#artifactHash': 'artifactHash',
          ...extraNames,
        },
        ExpressionAttributeValues: {
          ':tenantId': context.tenantId,
          ':operationId': claim.operationId,
          ':expectedStatus': context.status,
          ':claimOwner': claim.claimOwner,
          ':claimEpoch': claim.claimEpoch,
          ':expectedStateVersion': context.stateVersion,
          ':nextStateVersion': nextStateVersion,
          ':artifactHash': context.artifactHash,
          ...values,
        },
      },
      nextStateVersion,
    };
  }

  #forgetClaim(claim: OperationClaim, context: MutableClaimContext): void {
    this.#claimContexts.delete(claim);
    if (this.#activeClaims.get(claim.operationId) === context) {
      this.#activeClaims.delete(claim.operationId);
    }
  }

  async #update(
    input: ConstructorParameters<typeof UpdateCommand>[0],
  ): Promise<void> {
    try {
      await this.#client.send(new UpdateCommand(input));
    } catch (error) {
      if (isConditionalFailure(error)) throw new ConditionalRaceError();
      throw error;
    }
  }
}
