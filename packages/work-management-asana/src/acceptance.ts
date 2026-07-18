import { createHash } from 'node:crypto';

import {
  effectExecutionArtifactSchema,
  type EffectExecutionArtifact,
  type ProviderSendResult,
} from '@chief/contracts/approval';
import {
  connectorAccountSchema,
  connectorSnapshotSchema,
  type ConnectorAccount,
  type ConnectorAccountRef,
} from '@chief/contracts/connectors';
import { keyedDigestValueSchema } from '@chief/contracts/ids';
import {
  dispatchWorkManagementEffect,
  reconcileWorkManagementEffect,
  type EffectExecutionPersistence,
  type PersistedEffectAttempt,
} from '@chief/connector-core';

import { sha256 } from './canonical.js';
import { AsanaWorkManagementConnector } from './connector.js';
import { asanaWorkManagementConnectorDescriptor } from './implementation-metadata.js';
import { ASANA_ALL_TASK_HISTORY_FLOOR } from './transport.js';
import type {
  AsanaEffectPayload,
  AsanaResponse,
  AsanaTransport,
  AsanaTransportEvidence,
} from './types.js';

export const ASANA_ACCEPTANCE_DEFAULT_MAX_ITEMS = 20;
export const ASANA_ACCEPTANCE_DEFAULT_MAX_PAGES = 2;
export const ASANA_ACCEPTANCE_HARD_MAX_ITEMS = 50;
export const ASANA_ACCEPTANCE_HARD_MAX_PAGES = 3;
export const ASANA_ACCEPTANCE_OVERALL_DEADLINE_MILLISECONDS = 60_000;
const ACCEPTANCE_CORRELATION_DIGEST = keyedDigestValueSchema.parse(
  'h1_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
);

export type AsanaAcceptanceIssueCode =
  | 'ASANA_ACCEPTANCE_ARGUMENT_INVALID'
  | 'ASANA_ACCEPTANCE_AUTHORIZATION_INVALID'
  | 'ASANA_ACCEPTANCE_AUTHORIZATION_EXPIRED'
  | 'ASANA_ACCEPTANCE_AUTHORIZATION_MISMATCH'
  | 'ASANA_ACCEPTANCE_CREDENTIAL_INVALID'
  | 'ASANA_ACCEPTANCE_DUPLICATE_MARKER'
  | 'ASANA_ACCEPTANCE_MARKER_INVALID'
  | 'ASANA_ACCEPTANCE_MUTATION_REJECTED'
  | 'ASANA_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN'
  | 'ASANA_ACCEPTANCE_RESPONSE_INVALID'
  | 'ASANA_ACCEPTANCE_SCOPE_REJECTED'
  | 'ASANA_ACCEPTANCE_TIMEOUT'
  | 'ASANA_ACCEPTANCE_UNEXPECTED_FAILURE';

export class AsanaAcceptanceError extends Error {
  public constructor(public readonly code: AsanaAcceptanceIssueCode) {
    super(code);
    this.name = 'AsanaAcceptanceError';
  }
}

export interface AsanaControlledAuthorization {
  readonly schemaVersion: '1';
  readonly kind: 'asana_controlled_assessment_authorization';
  readonly authorizationId: string;
  readonly workspaceGid: string;
  readonly projectGid: string;
  readonly assessmentMarker: string;
  readonly authorizedOperations: readonly ['create_task', 'update_task'];
  readonly expiresAt: string;
}

export interface AsanaAcceptanceInput {
  readonly transport: AsanaTransport;
  readonly transportEvidence: readonly AsanaTransportEvidence[];
  readonly workspaceGid?: string;
  readonly projectGid?: string;
  readonly maxItems?: number;
  readonly maxPages?: number;
  readonly mutationAuthorization?: AsanaControlledAuthorization;
  readonly now?: () => string;
}

interface ProviderRecord {
  readonly gid: string;
  readonly name?: string;
  readonly modifiedAt?: string;
}

interface BoundedList {
  readonly records: readonly ProviderRecord[];
  readonly complete: boolean;
  readonly responseHashes: readonly string[];
}

export interface AsanaAcceptanceReport {
  readonly schemaVersion: '1';
  readonly mode: 'read_only_acceptance' | 'controlled_mutation_acceptance';
  readonly status: 'pass' | 'selection_required';
  readonly issueCodes: readonly AsanaAcceptanceIssueCode[];
  readonly observedAt: string;
  readonly bounds: {
    readonly maxItems: number;
    readonly maxPages: number;
    readonly hardMaxItems: typeof ASANA_ACCEPTANCE_HARD_MAX_ITEMS;
    readonly hardMaxPages: typeof ASANA_ACCEPTANCE_HARD_MAX_PAGES;
    readonly overallDeadlineMilliseconds: typeof ASANA_ACCEPTANCE_OVERALL_DEADLINE_MILLISECONDS;
    readonly retries: false;
  };
  readonly scopes: {
    readonly workspaceGid?: string;
    readonly projectGid?: string;
  };
  readonly choices: {
    readonly workspaceGids: readonly string[];
    readonly projectGids: readonly string[];
  };
  readonly observed: {
    readonly workspaceCount: number;
    readonly projectCount: number;
    readonly taskCount: number;
    readonly connectorFactCount: number;
    readonly complete: boolean;
  };
  readonly evidence: {
    readonly workspaceSetHash: string;
    readonly projectSetHash: string;
    readonly taskSetHash: string;
    readonly connectorFactSetHash: string;
    readonly providerResponseSetHash: string;
    readonly requests: readonly AsanaTransportEvidence[];
  };
  readonly mutation?: {
    readonly authorizationIdHash: string;
    readonly markerHash: string;
    readonly taskGid: string;
    readonly createOperationIdHash: string;
    readonly updateOperationIdHash: string;
    readonly createOutcome: 'accepted';
    readonly updateOutcome: 'accepted';
    readonly reconciledReadCount: 2;
  };
}

function stableHash(value: unknown): string {
  return sha256(value);
}

function safeTransportEvidence(
  items: readonly AsanaTransportEvidence[],
): readonly AsanaTransportEvidence[] {
  return items.map((item) => {
    const keys = Object.keys(item).sort();
    const expectedKeys = [
      'method',
      'status',
      ...(item.requestId === undefined ? [] : ['requestId']),
      ...(item.retryAfterSeconds === undefined ? [] : ['retryAfterSeconds']),
    ].sort();
    if (
      JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
      !['GET', 'POST', 'PUT'].includes(item.method) ||
      !Number.isSafeInteger(item.status) ||
      item.status < 100 ||
      item.status > 599 ||
      (item.requestId !== undefined &&
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.requestId)) ||
      (item.retryAfterSeconds !== undefined &&
        (item.status !== 429 ||
          !Number.isSafeInteger(item.retryAfterSeconds) ||
          item.retryAfterSeconds < 0 ||
          item.retryAfterSeconds > 86_400))
    ) {
      throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_RESPONSE_INVALID');
    }
    return Object.freeze({
      method: item.method,
      status: item.status,
      ...(item.requestId === undefined ? {} : { requestId: item.requestId }),
      ...(item.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: item.retryAfterSeconds }),
    });
  });
}

function dataRecords(
  response: AsanaResponse,
): readonly Record<string, unknown>[] {
  if (
    response.status !== 200 ||
    response.body === null ||
    typeof response.body !== 'object'
  ) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_RESPONSE_INVALID');
  }
  const data = (response.body as { readonly data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_RESPONSE_INVALID');
  }
  return data.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_RESPONSE_INVALID');
    }
    return item as Record<string, unknown>;
  });
}

function singleRecord(response: AsanaResponse): Record<string, unknown> {
  if (
    response.status !== 200 ||
    response.body === null ||
    typeof response.body !== 'object'
  ) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_RESPONSE_INVALID');
  }
  const data = (response.body as { readonly data?: unknown }).data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_RESPONSE_INVALID');
  }
  return data as Record<string, unknown>;
}

function requireGid(record: Record<string, unknown>): string {
  return providerGid(record.gid);
}

function providerGid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{1,64}$/u.test(value)) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_RESPONSE_INVALID');
  }
  return value;
}

function offset(response: AsanaResponse): string | undefined {
  if (response.body === null || typeof response.body !== 'object')
    return undefined;
  const page = (response.body as { readonly next_page?: unknown }).next_page;
  if (page === null || typeof page !== 'object') return undefined;
  const value = (page as { readonly offset?: unknown }).offset;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_RESPONSE_INVALID');
  }
  return value;
}

async function boundedList(input: {
  readonly transport: AsanaTransport;
  readonly account: ConnectorAccountRef;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly maxItems: number;
  readonly maxPages: number;
  readonly signal: AbortSignal;
}): Promise<BoundedList> {
  const records: ProviderRecord[] = [];
  const responseHashes: string[] = [];
  const seenOffsets = new Set<string>();
  let next: string | undefined;
  let complete = false;
  for (let page = 0; page < input.maxPages; page += 1) {
    const response = await input.transport.request({
      method: 'GET',
      path: input.path,
      query: {
        ...(input.query ?? {}),
        limit: String(Math.min(100, input.maxItems - records.length)),
        ...(next === undefined ? {} : { offset: next }),
      },
      account: input.account,
      signal: input.signal,
    });
    responseHashes.push(stableHash(response.body));
    const data = dataRecords(response);
    if (data.length > input.maxItems - records.length) {
      throw new AsanaAcceptanceError(
        'ASANA_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
      );
    }
    for (const record of data) {
      records.push({
        gid: requireGid(record),
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        ...(typeof record.modified_at === 'string'
          ? { modifiedAt: record.modified_at }
          : {}),
      });
    }
    next = offset(response);
    if (next === undefined) {
      complete = true;
      break;
    }
    if (seenOffsets.has(next)) {
      throw new AsanaAcceptanceError(
        'ASANA_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
      );
    }
    seenOffsets.add(next);
    if (records.length >= input.maxItems) break;
  }
  return { records, complete, responseHashes };
}

function liveSnapshot() {
  return connectorSnapshotSchema.parse({
    connectorId: asanaWorkManagementConnectorDescriptor.connectorId,
    descriptorVersion: asanaWorkManagementConnectorDescriptor.descriptorVersion,
    accountId: 'asana-live-acceptance',
    capabilitySnapshotHash: stableHash(
      asanaWorkManagementConnectorDescriptor.capabilities,
    ),
    runtimeMode: 'live',
    selectionState: 'selected',
  });
}

function liveAccount(
  snapshot: ReturnType<typeof liveSnapshot>,
  now: string,
): ConnectorAccount {
  return connectorAccountSchema.parse({
    tenantId: 'asana-acceptance-tenant',
    accountId: snapshot.accountId,
    ownerUserId: 'asana-acceptance-operator',
    provider: 'asana',
    channel: 'work_management',
    providerAccountDigest: 'h1_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    displayLabel: 'Controlled Asana acceptance account',
    snapshot,
    status: 'active',
    health: 'healthy',
    stateVersion: 1,
    updatedAt: now,
  });
}

function accountRef(account: ConnectorAccount): ConnectorAccountRef {
  return {
    tenantId: account.tenantId,
    accountId: account.accountId,
    expectedStateVersion: account.stateVersion,
  };
}

function nestedGids(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_RESPONSE_INVALID');
    }
    return providerGid((item as { readonly gid?: unknown }).gid);
  });
}

function validateBounds(input: AsanaAcceptanceInput): {
  maxItems: number;
  maxPages: number;
} {
  const maxItems = input.maxItems ?? ASANA_ACCEPTANCE_DEFAULT_MAX_ITEMS;
  const maxPages = input.maxPages ?? ASANA_ACCEPTANCE_DEFAULT_MAX_PAGES;
  if (
    (input.workspaceGid !== undefined &&
      !/^[0-9]{1,64}$/u.test(input.workspaceGid)) ||
    (input.projectGid !== undefined &&
      !/^[0-9]{1,64}$/u.test(input.projectGid)) ||
    !Number.isSafeInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > ASANA_ACCEPTANCE_HARD_MAX_ITEMS ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > ASANA_ACCEPTANCE_HARD_MAX_PAGES
  ) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_ARGUMENT_INVALID');
  }
  return { maxItems, maxPages };
}

export function validateControlledAuthorization(
  authorization: AsanaControlledAuthorization,
  workspaceGid: string,
  projectGid: string,
  now: string,
): void {
  if (
    authorization.schemaVersion !== '1' ||
    authorization.kind !== 'asana_controlled_assessment_authorization' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/u.test(authorization.authorizationId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/u.test(
      authorization.assessmentMarker,
    ) ||
    authorization.workspaceGid !== workspaceGid ||
    authorization.projectGid !== projectGid ||
    authorization.authorizedOperations.length !== 2 ||
    authorization.authorizedOperations[0] !== 'create_task' ||
    authorization.authorizedOperations[1] !== 'update_task'
  ) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_AUTHORIZATION_MISMATCH');
  }
  const expires = Date.parse(authorization.expiresAt);
  if (!Number.isFinite(expires)) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_AUTHORIZATION_INVALID');
  }
  if (expires <= Date.parse(now)) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_AUTHORIZATION_EXPIRED');
  }
}

class AcceptancePersistence implements EffectExecutionPersistence {
  readonly #attempts = new Map<string, PersistedEffectAttempt>();

  public prepareConditionally(artifact: EffectExecutionArtifact) {
    const current = this.#attempts.get(artifact.operationId);
    if (current !== undefined)
      return Promise.resolve({ status: 'existing' as const, attempt: current });
    const attempt = this.#store(artifact, 'prepared', 'queued');
    return Promise.resolve({ status: 'created' as const, attempt });
  }

  public claimDispatchConditionally(artifact: EffectExecutionArtifact) {
    const current = this.#attempts.get(artifact.operationId);
    if (current?.lifecycle !== 'prepared') {
      return Promise.resolve({
        status: 'contended' as const,
        attempt:
          current ??
          this.#store(
            artifact,
            'reconciliation_required',
            'acceptance_unknown',
          ),
      });
    }
    return Promise.resolve({
      status: 'claimed' as const,
      attempt: this.#store(artifact, 'dispatching', 'queued'),
    });
  }

  public releaseUncalledClaimConditionally(artifact: EffectExecutionArtifact) {
    return Promise.resolve(this.#store(artifact, 'prepared', 'queued'));
  }

  public claimReconciliationConditionally(artifact: EffectExecutionArtifact) {
    const current =
      this.#attempts.get(artifact.operationId) ??
      this.#store(artifact, 'reconciliation_required', 'acceptance_unknown');
    return Promise.resolve({ status: 'claimed' as const, attempt: current });
  }

  public releaseReconciliationClaimConditionally(
    artifact: EffectExecutionArtifact,
  ) {
    return Promise.resolve(
      this.#attempts.get(artifact.operationId) ??
        this.#store(artifact, 'reconciliation_required', 'acceptance_unknown'),
    );
  }

  public settleRejected(artifact: EffectExecutionArtifact) {
    return Promise.resolve(
      this.#store(artifact, 'settled', 'provider_rejected'),
    );
  }

  public settleAcceptedAndBindCorrelation(
    artifact: EffectExecutionArtifact,
    _result: Extract<ProviderSendResult, { readonly outcome: 'accepted' }>,
  ) {
    return Promise.resolve(
      this.#store(
        artifact,
        'settled',
        'provider_accepted',
        ACCEPTANCE_CORRELATION_DIGEST,
      ),
    );
  }

  public freezeAcceptanceUnknown(artifact: EffectExecutionArtifact) {
    return Promise.resolve(
      this.#store(artifact, 'reconciliation_required', 'acceptance_unknown'),
    );
  }

  #store(
    artifact: EffectExecutionArtifact,
    lifecycle: PersistedEffectAttempt['lifecycle'],
    transportState: PersistedEffectAttempt['transportState'],
    providerCorrelationDigest?: PersistedEffectAttempt['providerCorrelationDigest'],
  ): PersistedEffectAttempt {
    const attempt: PersistedEffectAttempt = {
      operationId: artifact.operationId,
      attemptId: artifact.attemptId,
      lifecycle,
      transportState,
      clientCorrelation: artifact.clientCorrelation,
      correlationBindingVersion: artifact.correlationBindingVersion,
      ...(providerCorrelationDigest === undefined
        ? {}
        : { providerCorrelationDigest }),
    };
    this.#attempts.set(artifact.operationId, attempt);
    return attempt;
  }
}

function artifact(
  payload: AsanaEffectPayload,
  account: ConnectorAccountRef,
  snapshot: ReturnType<typeof liveSnapshot>,
  marker: string,
  phase: 'create' | 'update',
  now: string,
): EffectExecutionArtifact {
  const identity = createHash('sha256')
    .update(`${marker}:${phase}`, 'utf8')
    .digest('hex');
  return effectExecutionArtifactSchema.parse({
    schemaVersion: '1',
    tenantId: account.tenantId,
    operationId: `asana-assessment-${phase}-${identity}`,
    attemptId: `asana-assessment-${phase}-${identity}-attempt-1`,
    stableIdempotencyKey: `asana-assessment-${phase}-${identity}`,
    account,
    sourceMessageRevisionId: `asana-assessment-message-${identity}`,
    actionPlanId: `asana-assessment-plan-${identity}`,
    actionPlanHash: stableHash({ marker, phase, kind: 'action-plan' }),
    approvalId: `asana-assessment-approval-${identity}`,
    renderedPayloadFingerprint: stableHash(payload),
    connectorSnapshot: snapshot,
    clientCorrelation: {
      kind: 'client_reference',
      value: `asana-assessment-${identity}`,
    },
    correlationBindingVersion: '1',
    reconciliationStrategy: 'asana-bounded-project-enumeration-and-direct-read',
    reconciliationStrategyVersion: '1',
    createdAt: now,
  });
}

async function controlledMutation(input: {
  readonly connector: AsanaWorkManagementConnector;
  readonly transport: AsanaTransport;
  readonly account: ConnectorAccount;
  readonly snapshot: ReturnType<typeof liveSnapshot>;
  readonly authorization: AsanaControlledAuthorization;
  readonly existingTasks: readonly ProviderRecord[];
  readonly now: string;
  readonly signal: AbortSignal;
}): Promise<NonNullable<AsanaAcceptanceReport['mutation']>> {
  const marker = input.authorization.assessmentMarker;
  if (input.existingTasks.some((task) => task.name === undefined)) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_RESPONSE_INVALID');
  }
  const matching = input.existingTasks.filter(
    (task) => task.name?.includes(marker) === true,
  );
  if (matching.length > 0) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_DUPLICATE_MARKER');
  }
  const payloads = new Map<string, AsanaEffectPayload>();
  const connector = new AsanaWorkManagementConnector({
    clientId: 'pat-acceptance-no-oauth-flow',
    scope: {
      workspaceGid: input.authorization.workspaceGid,
      projectGids: [input.authorization.projectGid],
      pollingResourceGids: [input.authorization.projectGid],
    },
    currentSnapshot: input.snapshot,
    transport: input.transport,
    authorization: {
      completeAuthorization: () =>
        Promise.reject(new Error('ASANA_ACCEPTANCE_OAUTH_DISABLED')),
    },
    effectPayloads: {
      loadExactPayload: (effectArtifact) => {
        const payload = payloads.get(effectArtifact.operationId);
        if (payload === undefined)
          throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_MUTATION_REJECTED');
        return Promise.resolve(payload);
      },
    },
    webhookVerificationKey: 'asana-acceptance-unused-webhook-key',
    webhookTargetUrl: 'https://example.invalid/asana-acceptance-unused',
    clock: { now: () => input.now },
    signal: input.signal,
  });
  const ref = accountRef(input.account);
  const persistence = new AcceptancePersistence();
  const createName = `[Chief assessment ${marker}] controlled task`;
  const createPayload: AsanaEffectPayload = {
    kind: 'create_task',
    workspaceGid: input.authorization.workspaceGid,
    projectGid: input.authorization.projectGid,
    fields: { name: createName },
  };
  const createArtifact = artifact(
    createPayload,
    ref,
    input.snapshot,
    marker,
    'create',
    input.now,
  );
  payloads.set(createArtifact.operationId, createPayload);
  const exactAuthority = {
    assertCurrent: (candidate: EffectExecutionArtifact) => {
      if (stableHash(candidate) !== stableHash(createArtifact)) {
        throw new AsanaAcceptanceError(
          'ASANA_ACCEPTANCE_AUTHORIZATION_MISMATCH',
        );
      }
      return Promise.resolve();
    },
  };
  let created = await dispatchWorkManagementEffect(
    connector,
    persistence,
    exactAuthority,
    ref,
    createArtifact,
    input.snapshot,
  );
  if (created.status === 'reconciliation_required') {
    created = await reconcileWorkManagementEffect(
      connector,
      persistence,
      {
        assertReadableForReconciliation: (
          candidateAccount,
          candidateArtifact,
        ) => {
          if (
            stableHash(candidateAccount) !== stableHash(ref) ||
            stableHash(candidateArtifact) !== stableHash(createArtifact)
          ) {
            throw new AsanaAcceptanceError(
              'ASANA_ACCEPTANCE_AUTHORIZATION_MISMATCH',
            );
          }
          return Promise.resolve();
        },
      },
      ref,
      createArtifact,
      input.snapshot,
    );
  }
  if (
    created.status !== 'settled' ||
    created.providerResult.outcome !== 'accepted'
  ) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_MUTATION_REJECTED');
  }
  const taskGid = providerGid(created.providerResult.providerCorrelation);
  const createdRead = singleRecord(
    await input.transport.request({
      method: 'GET',
      path: `/tasks/${encodeURIComponent(taskGid)}`,
      query: {
        opt_fields:
          'gid,name,modified_at,workspace.gid,memberships.project.gid',
      },
      account: ref,
      signal: input.signal,
    }),
  );
  if (
    requireGid(createdRead) !== taskGid ||
    typeof createdRead.modified_at !== 'string' ||
    createdRead.name !== createName
  ) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_RESPONSE_INVALID');
  }
  await connector.fetchObject(input.account, {
    kind: 'task',
    providerObjectId: taskGid,
  });
  const updateName = `[Chief assessment ${marker}] controlled task verified`;
  const updatePayload: AsanaEffectPayload = {
    kind: 'update_task',
    taskGid,
    fields: { name: updateName },
    precondition: { modifiedAt: createdRead.modified_at },
  };
  const updateArtifact = artifact(
    updatePayload,
    ref,
    input.snapshot,
    marker,
    'update',
    input.now,
  );
  payloads.set(updateArtifact.operationId, updatePayload);
  const updateAuthority = {
    assertCurrent: (candidate: EffectExecutionArtifact) => {
      if (stableHash(candidate) !== stableHash(updateArtifact)) {
        throw new AsanaAcceptanceError(
          'ASANA_ACCEPTANCE_AUTHORIZATION_MISMATCH',
        );
      }
      return Promise.resolve();
    },
  };
  let updated = await dispatchWorkManagementEffect(
    connector,
    persistence,
    updateAuthority,
    ref,
    updateArtifact,
    input.snapshot,
  );
  if (updated.status === 'reconciliation_required') {
    updated = await reconcileWorkManagementEffect(
      connector,
      persistence,
      {
        assertReadableForReconciliation: (
          candidateAccount,
          candidateArtifact,
        ) => {
          if (
            stableHash(candidateAccount) !== stableHash(ref) ||
            stableHash(candidateArtifact) !== stableHash(updateArtifact)
          ) {
            throw new AsanaAcceptanceError(
              'ASANA_ACCEPTANCE_AUTHORIZATION_MISMATCH',
            );
          }
          return Promise.resolve();
        },
      },
      ref,
      updateArtifact,
      input.snapshot,
    );
  }
  if (
    updated.status !== 'settled' ||
    updated.providerResult.outcome !== 'accepted'
  ) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_MUTATION_REJECTED');
  }
  const updatedRead = singleRecord(
    await input.transport.request({
      method: 'GET',
      path: `/tasks/${encodeURIComponent(taskGid)}`,
      query: {
        opt_fields:
          'gid,name,modified_at,workspace.gid,memberships.project.gid',
      },
      account: ref,
      signal: input.signal,
    }),
  );
  if (requireGid(updatedRead) !== taskGid || updatedRead.name !== updateName) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_RESPONSE_INVALID');
  }
  await connector.fetchObject(input.account, {
    kind: 'task',
    providerObjectId: taskGid,
  });
  return {
    authorizationIdHash: stableHash(input.authorization.authorizationId),
    markerHash: stableHash(marker),
    taskGid,
    createOperationIdHash: stableHash(createArtifact.operationId),
    updateOperationIdHash: stableHash(updateArtifact.operationId),
    createOutcome: 'accepted',
    updateOutcome: 'accepted',
    reconciledReadCount: 2,
  };
}

async function runWithinDeadline(
  input: AsanaAcceptanceInput,
  signal: AbortSignal,
): Promise<AsanaAcceptanceReport> {
  const { maxItems, maxPages } = validateBounds(input);
  const observedAt = (input.now ?? (() => new Date().toISOString()))();
  const snapshot = liveSnapshot();
  const account = liveAccount(snapshot, observedAt);
  const ref = accountRef(account);
  const meResponse = await input.transport.request({
    method: 'GET',
    path: '/users/me',
    query: { opt_fields: 'gid,workspaces.gid' },
    account: ref,
    signal,
  });
  const me = singleRecord(meResponse);
  const allWorkspaceGids = nestedGids(me.workspaces);
  const workspaceDiscoveryComplete = allWorkspaceGids.length <= maxItems;
  const workspaceGids = allWorkspaceGids.slice(0, maxItems);
  if (
    input.workspaceGid !== undefined &&
    !allWorkspaceGids.includes(input.workspaceGid)
  ) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_SCOPE_REJECTED');
  }
  let projectList: BoundedList = {
    records: [],
    complete: true,
    responseHashes: [],
  };
  if (input.workspaceGid !== undefined) {
    projectList = await boundedList({
      transport: input.transport,
      account: ref,
      path: `/workspaces/${encodeURIComponent(input.workspaceGid)}/projects`,
      query: { archived: 'false', opt_fields: 'gid' },
      maxItems,
      maxPages,
      signal,
    });
    // This bounded list is discovery evidence. An exact project GID is
    // independently verified by the scoped connector read below, so a large
    // workspace cannot make an exact selection fail merely because the chosen
    // project falls beyond the discovery bound.
  }
  let taskList: BoundedList = {
    records: [],
    complete: true,
    responseHashes: [],
  };
  const connectorFacts: Array<{
    kind: string;
    gid: string;
    version: string;
    hash: string;
  }> = [];
  let connector: AsanaWorkManagementConnector | undefined;
  if (input.workspaceGid !== undefined && input.projectGid !== undefined) {
    taskList = await boundedList({
      transport: input.transport,
      account: ref,
      path: `/projects/${encodeURIComponent(input.projectGid)}/tasks`,
      query: {
        opt_fields:
          'gid,name,modified_at,workspace.gid,memberships.project.gid',
        completed_since: ASANA_ALL_TASK_HISTORY_FLOOR,
      },
      maxItems,
      maxPages,
      signal,
    });
    connector = new AsanaWorkManagementConnector({
      clientId: 'pat-acceptance-no-oauth-flow',
      scope: {
        workspaceGid: input.workspaceGid,
        projectGids: [input.projectGid],
        pollingResourceGids: [input.projectGid],
      },
      currentSnapshot: snapshot,
      transport: input.transport,
      authorization: {
        completeAuthorization: () =>
          Promise.reject(new Error('ASANA_ACCEPTANCE_OAUTH_DISABLED')),
      },
      effectPayloads: {
        loadExactPayload: () =>
          Promise.reject(new Error('ASANA_ACCEPTANCE_EFFECT_DISABLED')),
      },
      webhookVerificationKey: 'asana-acceptance-unused-webhook-key',
      webhookTargetUrl: 'https://example.invalid/asana-acceptance-unused',
      clock: { now: () => observedAt },
      signal,
    });
    const health = await connector.validateConnection(ref);
    if (health.health !== 'healthy') {
      throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_SCOPE_REJECTED');
    }
    const projectFact = await connector.fetchObject(account, {
      kind: 'project',
      providerObjectId: input.projectGid,
    });
    connectorFacts.push({
      kind: projectFact.kind,
      gid: projectFact.providerObjectId,
      version: projectFact.providerVersion,
      hash: projectFact.payloadFingerprint,
    });
    for (const task of taskList.records) {
      const fact = await connector.fetchObject(account, {
        kind: 'task',
        providerObjectId: task.gid,
      });
      connectorFacts.push({
        kind: fact.kind,
        gid: fact.providerObjectId,
        version: fact.providerVersion,
        hash: fact.payloadFingerprint,
      });
    }
  }
  let mutation: AsanaAcceptanceReport['mutation'];
  if (input.mutationAuthorization !== undefined) {
    if (
      input.workspaceGid === undefined ||
      input.projectGid === undefined ||
      connector === undefined
    ) {
      throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_ARGUMENT_INVALID');
    }
    validateControlledAuthorization(
      input.mutationAuthorization,
      input.workspaceGid,
      input.projectGid,
      observedAt,
    );
    if (!taskList.complete) {
      throw new AsanaAcceptanceError(
        'ASANA_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
      );
    }
    mutation = await controlledMutation({
      connector,
      transport: input.transport,
      account,
      snapshot,
      authorization: input.mutationAuthorization,
      existingTasks: taskList.records,
      now: observedAt,
      signal,
    });
  }
  const workspaceIds = [...workspaceGids].sort();
  const projectIds = projectList.records.map(({ gid }) => gid).sort();
  const taskIds = taskList.records.map(({ gid }) => gid).sort();
  const responseHashes = [
    stableHash(meResponse.body),
    ...projectList.responseHashes,
    ...taskList.responseHashes,
  ].sort();
  return {
    schemaVersion: '1',
    mode:
      mutation === undefined
        ? 'read_only_acceptance'
        : 'controlled_mutation_acceptance',
    status:
      input.workspaceGid === undefined || input.projectGid === undefined
        ? 'selection_required'
        : 'pass',
    issueCodes: [],
    observedAt,
    bounds: {
      maxItems,
      maxPages,
      hardMaxItems: ASANA_ACCEPTANCE_HARD_MAX_ITEMS,
      hardMaxPages: ASANA_ACCEPTANCE_HARD_MAX_PAGES,
      overallDeadlineMilliseconds:
        ASANA_ACCEPTANCE_OVERALL_DEADLINE_MILLISECONDS,
      retries: false,
    },
    scopes: {
      ...(input.workspaceGid === undefined
        ? {}
        : { workspaceGid: input.workspaceGid }),
      ...(input.projectGid === undefined
        ? {}
        : { projectGid: input.projectGid }),
    },
    choices: { workspaceGids: workspaceIds, projectGids: projectIds },
    observed: {
      workspaceCount: workspaceIds.length,
      projectCount: projectIds.length,
      taskCount: taskIds.length,
      connectorFactCount: connectorFacts.length,
      complete:
        workspaceDiscoveryComplete && projectList.complete && taskList.complete,
    },
    evidence: {
      workspaceSetHash: stableHash(workspaceIds),
      projectSetHash: stableHash(projectIds),
      taskSetHash: stableHash(taskIds),
      connectorFactSetHash: stableHash(connectorFacts),
      providerResponseSetHash: stableHash(responseHashes),
      requests: safeTransportEvidence(input.transportEvidence),
    },
    ...(mutation === undefined ? {} : { mutation }),
  };
}

export async function runAsanaAcceptance(
  input: AsanaAcceptanceInput,
): Promise<AsanaAcceptanceReport> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    return await Promise.race([
      runWithinDeadline(input, controller.signal).catch((error: unknown) => {
        if (controller.signal.aborted) {
          throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_TIMEOUT');
        }
        throw error;
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AsanaAcceptanceError('ASANA_ACCEPTANCE_TIMEOUT'));
        }, ASANA_ACCEPTANCE_OVERALL_DEADLINE_MILLISECONDS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function acceptanceIssueCode(error: unknown): AsanaAcceptanceIssueCode {
  return error instanceof AsanaAcceptanceError
    ? error.code
    : 'ASANA_ACCEPTANCE_UNEXPECTED_FAILURE';
}
