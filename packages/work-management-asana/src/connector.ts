import {
  effectExecutionArtifactSchema,
  providerSendResultSchema,
} from '@chief/contracts/approval';
import type {
  EffectExecutionArtifact,
  ProviderSendResult,
} from '@chief/contracts/approval';
import {
  connectionHealthSchema,
  connectorAccountSchema,
  connectorSnapshotSchema,
  providerSubscriptionResultSchema,
  syncPageSchema,
  workObjectFactSchema,
} from '@chief/contracts/connectors';
import type { WorkManagementConnector } from '@chief/connector-core';
import type {
  AuthorizationCallback,
  AuthorizationInput,
  AuthorizationStart,
  ConnectionHealth,
  ConnectorAccount,
  ConnectorAccountRef,
  PollRequest,
  ProviderSubscriptionResult,
  RawWebhookRequest,
  SubscriptionMutationRequest,
  SyncPage,
  WorkObjectFact,
  WorkObjectRef,
} from '@chief/contracts/connectors';

import { canonicalJson, freezeDeep, sha256 } from './canonical.js';
import { asanaWorkManagementConnectorDescriptor } from './implementation-metadata.js';
import type {
  AsanaCompactEvent,
  AsanaConnectorOptions,
  AsanaEffectPayload,
  AsanaRequest,
  AsanaResponse,
} from './types.js';
import { verifyAsanaWebhook } from './webhook.js';

const API_FIELDS =
  'gid,resource_type,resource_subtype,name,modified_at,created_at,permalink_url,workspace.gid,projects.gid,memberships.project.gid,target.gid,target.resource_type,target.workspace.gid,target.projects.gid';

export class AsanaRateLimitError extends Error {
  public readonly retryAfterSeconds: number;

  public constructor(retryAfterSeconds: number) {
    super('ASANA_RATE_LIMITED');
    this.name = 'AsanaRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class AsanaConnectorError extends Error {
  public constructor(code: string) {
    super(code);
    this.name = 'AsanaConnectorError';
  }
}

function responseData(response: AsanaResponse): Record<string, unknown> {
  const body = response.body;
  if (body === null || typeof body !== 'object') {
    throw new AsanaConnectorError('ASANA_RESPONSE_INVALID');
  }
  const data = (body as { data?: unknown }).data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new AsanaConnectorError('ASANA_RESPONSE_INVALID');
  }
  return data as Record<string, unknown>;
}

function responseArray(response: AsanaResponse): readonly unknown[] {
  const body = response.body;
  if (body === null || typeof body !== 'object') {
    throw new AsanaConnectorError('ASANA_RESPONSE_INVALID');
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new AsanaConnectorError('ASANA_RESPONSE_INVALID');
  }
  return data;
}

function providerError(response: AsanaResponse): never {
  if (response.status === 429) {
    const seconds = Number(response.headers['retry-after'] ?? '60');
    throw new AsanaRateLimitError(Number.isFinite(seconds) ? seconds : 60);
  }
  throw new AsanaConnectorError(`ASANA_HTTP_${response.status}`);
}

function getString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AsanaConnectorError('ASANA_RESPONSE_INVALID');
  }
  return value;
}

function nestedGids(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap<string>((item) => {
    if (item === null || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (typeof record.gid === 'string') return [record.gid];
    const project = record.project;
    return project !== null &&
      typeof project === 'object' &&
      typeof (project as Record<string, unknown>).gid === 'string'
      ? [String((project as Record<string, unknown>).gid)]
      : [];
  });
}

function nestedWorkspaceGid(
  record: Record<string, unknown>,
): string | undefined {
  const workspace = record.workspace;
  if (workspace !== null && typeof workspace === 'object') {
    const gid = (workspace as Record<string, unknown>).gid;
    if (typeof gid === 'string') return gid;
  }
  const target = record.target;
  if (target !== null && typeof target === 'object') {
    return nestedWorkspaceGid(target as Record<string, unknown>);
  }
  return undefined;
}

function mappedFields(payload: AsanaEffectPayload): Record<string, unknown> {
  if (payload.kind === 'create_comment') return { text: payload.text };
  const fields = payload.fields;
  return {
    ...('name' in fields && fields.name !== undefined
      ? { name: fields.name }
      : {}),
    ...('notes' in fields && fields.notes !== undefined
      ? { notes: fields.notes }
      : {}),
    ...('assignee' in fields && fields.assignee !== undefined
      ? { assignee: fields.assignee }
      : {}),
    ...('dueOn' in fields && fields.dueOn !== undefined
      ? { due_on: fields.dueOn }
      : {}),
    ...('completed' in fields && fields.completed !== undefined
      ? { completed: fields.completed }
      : {}),
  };
}

export class AsanaWorkManagementConnector {
  public readonly connectorKind = 'work_management' as const;
  readonly #options: AsanaConnectorOptions;

  public constructor(options: AsanaConnectorOptions) {
    const currentSnapshot = connectorSnapshotSchema.safeParse(
      options.currentSnapshot,
    );
    if (
      !currentSnapshot.success ||
      options.clientId.length === 0 ||
      options.scope.workspaceGid.length === 0 ||
      options.webhookVerificationKey.length === 0 ||
      !options.webhookTargetUrl.startsWith('https://') ||
      currentSnapshot.data.connectorId !==
        asanaWorkManagementConnectorDescriptor.connectorId ||
      currentSnapshot.data.descriptorVersion !==
        asanaWorkManagementConnectorDescriptor.descriptorVersion ||
      currentSnapshot.data.capabilitySnapshotHash !==
        sha256(asanaWorkManagementConnectorDescriptor.capabilities) ||
      currentSnapshot.data.selectionState !== 'selected' ||
      !['live', 'virtual_test'].includes(currentSnapshot.data.runtimeMode)
    ) {
      throw new AsanaConnectorError('ASANA_CONFIGURATION_INVALID');
    }
    this.#options = {
      ...options,
      scope: freezeDeep({
        workspaceGid: options.scope.workspaceGid,
        projectGids: [...options.scope.projectGids],
        pollingResourceGids: [...options.scope.pollingResourceGids],
      }),
      currentSnapshot: freezeDeep(currentSnapshot.data),
    };
  }

  public descriptor() {
    return asanaWorkManagementConnectorDescriptor;
  }

  public authorizationStrategy() {
    return freezeDeep({
      strategy: 'oauth' as const,
      audience: asanaWorkManagementConnectorDescriptor.authorizationAudience!,
      scopes: [...asanaWorkManagementConnectorDescriptor.authorizationScopes],
    });
  }

  public beginAuthorization(
    input: AuthorizationInput,
  ): Promise<AuthorizationStart> {
    if (
      input.connectorId !==
        asanaWorkManagementConnectorDescriptor.connectorId ||
      canonicalJson(input.requestedScopes) !==
        canonicalJson(
          asanaWorkManagementConnectorDescriptor.authorizationScopes,
        )
    ) {
      throw new AsanaConnectorError('ASANA_OAUTH_SCOPE_MISMATCH');
    }
    const url = new URL('https://app.asana.com/-/oauth_authorize');
    url.searchParams.set('client_id', this.#options.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', input.stateDigest);
    url.searchParams.set('code_challenge', input.pkceChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return Promise.resolve(
      freezeDeep({
        authorizationUrl: url.toString(),
        stateDigest: input.stateDigest,
        expiresAt: new Date(
          Date.parse(this.#options.clock.now()) + 600_000,
        ).toISOString(),
      }),
    );
  }

  public async completeAuthorization(
    input: AuthorizationCallback,
  ): Promise<ConnectorAccount> {
    const account = connectorAccountSchema.parse(
      await this.#options.authorization.completeAuthorization(input),
    );
    if (
      account.tenantId !== input.tenantId ||
      account.ownerUserId !== input.userId ||
      account.provider !== 'asana' ||
      canonicalJson(account.snapshot) !==
        canonicalJson(this.#options.currentSnapshot)
    ) {
      throw new AsanaConnectorError('ASANA_OAUTH_ACCOUNT_BINDING_MISMATCH');
    }
    return freezeDeep(account);
  }

  public async validateConnection(
    account: ConnectorAccountRef,
  ): Promise<ConnectionHealth> {
    this.#assertCurrentAccountRef(account);
    const response = await this.#request({
      method: 'GET',
      path: '/users/me',
      query: { opt_fields: 'gid,name,workspaces.gid,workspaces.name' },
      account,
    });
    const healthy =
      response.status === 200 &&
      nestedGids(responseData(response).workspaces).includes(
        this.#options.scope.workspaceGid,
      );
    return connectionHealthSchema.parse({
      account,
      health: healthy ? 'healthy' : 'failed',
      observedAt: this.#options.clock.now(),
      capabilitySnapshotHash: sha256(
        asanaWorkManagementConnectorDescriptor.capabilities,
      ),
      ...(!healthy ? { errorCode: 'ASANA_WORKSPACE_SCOPE_UNAVAILABLE' } : {}),
    });
  }

  public async fetchObject(
    account: ConnectorAccount,
    ref: WorkObjectRef,
  ): Promise<WorkObjectFact> {
    if (
      account.provider !== 'asana' ||
      canonicalJson(account.snapshot) !==
        canonicalJson(this.#options.currentSnapshot)
    ) {
      throw new AsanaConnectorError('ASANA_ACCOUNT_BINDING_MISMATCH');
    }
    const resource =
      ref.kind === 'comment'
        ? 'stories'
        : ref.kind === 'project'
          ? 'projects'
          : 'tasks';
    const response = await this.#request({
      method: 'GET',
      path: `/${resource}/${encodeURIComponent(ref.providerObjectId)}`,
      query: { opt_fields: API_FIELDS },
      account: {
        tenantId: account.tenantId,
        accountId: account.accountId,
        expectedStateVersion: account.stateVersion,
      },
    });
    if (response.status !== 200) providerError(response);
    const data = responseData(response);
    if (getString(data, 'gid') !== ref.providerObjectId) {
      throw new AsanaConnectorError('ASANA_OBJECT_BINDING_MISMATCH');
    }
    this.#assertObjectScope(ref.kind, data);
    if (ref.kind === 'milestone' && data.resource_subtype !== 'milestone') {
      throw new AsanaConnectorError('ASANA_OBJECT_KIND_MISMATCH');
    }
    if (ref.kind === 'comment' && data.resource_type !== 'story') {
      throw new AsanaConnectorError('ASANA_OBJECT_KIND_MISMATCH');
    }
    const timestamp =
      typeof data.modified_at === 'string'
        ? data.modified_at
        : getString(data, 'created_at');
    return workObjectFactSchema.parse({
      kind: ref.kind,
      providerObjectId: ref.providerObjectId,
      providerVersion: timestamp,
      providerTimestamp: timestamp,
      payloadFingerprint: sha256(response.body),
    });
  }

  public subscribe(
    account: ConnectorAccountRef,
    request: SubscriptionMutationRequest,
  ): Promise<ProviderSubscriptionResult> {
    this.#assertCurrentAccountRef(account);
    this.#assertSameAccountRef(account, request.account);
    return this.#createSubscription(account, request);
  }

  public async renewSubscription(
    account: ConnectorAccountRef,
    request: SubscriptionMutationRequest,
  ): Promise<ProviderSubscriptionResult> {
    this.#assertCurrentAccountRef(account);
    this.#assertSameAccountRef(account, request.account);
    const response = await this.#request({
      method: 'GET',
      path: '/webhooks',
      query: { workspace: this.#options.scope.workspaceGid },
      account,
    });
    if (response.status !== 200) providerError(response);
    const match = responseArray(response).find((item) => {
      if (item === null || typeof item !== 'object') return false;
      const record = item as Record<string, unknown>;
      const resource = record.resource;
      return (
        record.target === this.#options.webhookTargetUrl &&
        resource !== null &&
        typeof resource === 'object' &&
        (resource as Record<string, unknown>).gid ===
          this.#options.scope.workspaceGid
      );
    });
    if (match === undefined || match === null || typeof match !== 'object') {
      throw new AsanaConnectorError('ASANA_WEBHOOK_HEARTBEAT_MISSING');
    }
    const gid = getString(match as Record<string, unknown>, 'gid');
    const now = this.#options.clock.now();
    return providerSubscriptionResultSchema.parse({
      providerReference: gid,
      providerResponseHash: sha256(response.body),
      expiresAt: new Date(Date.parse(now) + 86_400_000).toISOString(),
      renewAfter: new Date(Date.parse(now) + 3_600_000).toISOString(),
      observedAt: now,
    });
  }

  public async poll(
    account: ConnectorAccountRef,
    request: PollRequest,
  ): Promise<SyncPage> {
    this.#assertCurrentAccountRef(account);
    this.#assertSameAccountRef(account, request.account);
    if (
      request.adapterVersion !==
      asanaWorkManagementConnectorDescriptor.descriptorVersion
    ) {
      throw new AsanaConnectorError('ASANA_POLL_ADAPTER_VERSION_MISMATCH');
    }
    let cursor = request.checkpoint.encryptedCursor;
    let offset: string | undefined;
    let pages = 0;
    const envelopes: Array<SyncPage['envelopes'][number]> = [];
    let finalBody: unknown = {};
    let complete = true;

    while (pages < request.maxPages && envelopes.length < request.maxItems) {
      const resource =
        this.#options.scope.pollingResourceGids[
          pages % this.#options.scope.pollingResourceGids.length
        ] ?? this.#options.scope.workspaceGid;
      const response = await this.#request({
        method: 'GET',
        path: '/events',
        query: {
          resource,
          sync: cursor,
          ...(offset === undefined ? {} : { offset }),
          limit: String(Math.min(100, request.maxItems - envelopes.length)),
        },
        account,
      });
      if (response.status !== 200) providerError(response);
      finalBody = response.body;
      const body = response.body as {
        data?: unknown[];
        sync?: string;
        next_page?: { offset?: string } | null;
      };
      if (!Array.isArray(body.data) || typeof body.sync !== 'string') {
        throw new AsanaConnectorError('ASANA_POLL_RESPONSE_INVALID');
      }
      cursor = body.sync;
      for (const event of body.data) {
        if (envelopes.length >= request.maxItems) break;
        if (event === null || typeof event !== 'object') {
          throw new AsanaConnectorError('ASANA_POLL_RESPONSE_INVALID');
        }
        const record = event as Record<string, unknown>;
        const resourceRecord = record.resource;
        if (resourceRecord === null || typeof resourceRecord !== 'object') {
          throw new AsanaConnectorError('ASANA_POLL_RESPONSE_INVALID');
        }
        const gid = getString(resourceRecord as Record<string, unknown>, 'gid');
        const resourceType = getString(
          resourceRecord as Record<string, unknown>,
          'resource_type',
        );
        const timestamp = getString(record, 'created_at');
        envelopes.push({
          schemaVersion: '1',
          account,
          providerMessageRef: {
            providerMessageId: `${resourceType}:${gid}`,
          },
          sourceTimestamp: timestamp,
          rawBodyRef: `asana-event://${encodeURIComponent(gid)}`,
          canonicalPayloadHash: sha256(event),
          attachmentCount: 0,
          connectorSnapshot: this.#options.currentSnapshot,
        });
      }
      pages += 1;
      offset = body.next_page?.offset;
      if (offset === undefined) break;
    }
    if (offset !== undefined || envelopes.length >= request.maxItems) {
      complete = false;
    }
    return syncPageSchema.parse({
      envelopes,
      nextEncryptedCursor: cursor,
      sourceWatermark: cursor,
      complete,
      providerResponseHash: sha256(finalBody),
    });
  }

  public verifyWebhook(request: RawWebhookRequest) {
    return verifyAsanaWebhook(request, this.#options.webhookVerificationKey);
  }

  public fetchWebhookEvent(
    account: ConnectorAccount,
    event: AsanaCompactEvent,
  ): Promise<WorkObjectFact> {
    return this.fetchObject(account, {
      kind: event.kind,
      providerObjectId: event.gid,
    });
  }

  public async execute(
    account: ConnectorAccountRef,
    artifactInput: EffectExecutionArtifact,
  ): Promise<ProviderSendResult> {
    const artifact = this.#assertArtifact(account, artifactInput);
    const payload =
      await this.#options.effectPayloads.loadExactPayload(artifact);
    this.#assertPayload(artifact, payload);
    if (payload.kind !== 'create_task' && payload.precondition !== undefined) {
      await this.#assertPrecondition(
        account,
        payload.taskGid,
        payload.precondition.modifiedAt,
      );
    }
    const request = this.#effectRequest(account, artifact, payload);
    let response: AsanaResponse;
    try {
      response = await this.#request(request);
    } catch (error) {
      if (error instanceof AsanaRateLimitError) {
        return providerSendResultSchema.parse({
          outcome: 'rejected',
          providerResponseHash: sha256({ rateLimited: true }),
          reasonCode: 'rate_limited',
          observedAt: this.#options.clock.now(),
        });
      }
      return providerSendResultSchema.parse({
        outcome: 'acceptance_unknown',
        reasonCode: 'transport_outcome_unknown',
        observedAt: this.#options.clock.now(),
      });
    }
    return this.#effectResult(response);
  }

  public async reconcileEffect(
    account: ConnectorAccountRef,
    artifactInput: EffectExecutionArtifact,
  ): Promise<ProviderSendResult> {
    const artifact = this.#assertArtifact(account, artifactInput);
    const payload =
      await this.#options.effectPayloads.loadExactPayload(artifact);
    this.#assertPayload(artifact, payload);
    if (this.#options.transport.reconcileEffect === undefined) {
      return providerSendResultSchema.parse({
        outcome: 'acceptance_unknown',
        reasonCode: 'asana_reconciliation_unavailable',
        observedAt: this.#options.clock.now(),
      });
    }
    const result = await this.#options.transport.reconcileEffect(
      account,
      artifact,
      payload,
    );
    if (result.outcome === 'accepted') {
      return providerSendResultSchema.parse({
        outcome: 'accepted',
        providerResponseHash: sha256(result.response),
        providerCorrelation: result.gid,
        observedAt: this.#options.clock.now(),
      });
    }
    if (result.outcome === 'proven_nonacceptance') {
      return providerSendResultSchema.parse({
        outcome: 'rejected',
        providerResponseHash: sha256(result.response),
        reasonCode: 'proven_nonacceptance',
        observedAt: this.#options.clock.now(),
      });
    }
    return providerSendResultSchema.parse({
      outcome: 'acceptance_unknown',
      ...(result.response === undefined
        ? {}
        : { providerResponseHash: sha256(result.response) }),
      reasonCode: result.reasonCode,
      observedAt: this.#options.clock.now(),
    });
  }

  async #createSubscription(
    account: ConnectorAccountRef,
    request: SubscriptionMutationRequest,
  ): Promise<ProviderSubscriptionResult> {
    const response = await this.#request({
      method: 'POST',
      path: '/webhooks',
      account,
      operationId: request.providerIdempotencyKey,
      body: {
        data: {
          resource: this.#options.scope.workspaceGid,
          target: this.#options.webhookTargetUrl,
          filters: [
            { resource_type: 'task' },
            { resource_type: 'project' },
            { resource_type: 'story' },
          ],
        },
      },
    });
    if (response.status !== 201) providerError(response);
    const data = responseData(response);
    const now = this.#options.clock.now();
    return providerSubscriptionResultSchema.parse({
      providerReference: getString(data, 'gid'),
      providerResponseHash: sha256(response.body),
      expiresAt: request.requestedExpiresAt,
      renewAfter: new Date(
        Date.parse(request.requestedExpiresAt) - 3_600_000,
      ).toISOString(),
      observedAt: now,
    });
  }

  #assertArtifact(
    account: ConnectorAccountRef,
    input: EffectExecutionArtifact,
  ): EffectExecutionArtifact {
    const artifact = effectExecutionArtifactSchema.parse(input);
    this.#assertCurrentAccountRef(account);
    if (
      artifact.account.tenantId !== account.tenantId ||
      artifact.account.accountId !== account.accountId ||
      artifact.account.expectedStateVersion !== account.expectedStateVersion ||
      canonicalJson(artifact.connectorSnapshot) !==
        canonicalJson(this.#options.currentSnapshot)
    ) {
      throw new AsanaConnectorError('ASANA_EFFECT_ARTIFACT_BINDING_MISMATCH');
    }
    return artifact;
  }

  #assertPayload(
    artifact: EffectExecutionArtifact,
    payload: AsanaEffectPayload,
  ): void {
    if (sha256(payload) !== artifact.renderedPayloadFingerprint) {
      throw new AsanaConnectorError(
        'ASANA_EFFECT_PAYLOAD_FINGERPRINT_MISMATCH',
      );
    }
    if (
      payload.kind === 'create_task' &&
      (payload.workspaceGid !== this.#options.scope.workspaceGid ||
        (this.#options.scope.projectGids.length > 0 &&
          (payload.projectGid === undefined ||
            !this.#options.scope.projectGids.includes(payload.projectGid))))
    ) {
      throw new AsanaConnectorError('ASANA_EFFECT_SCOPE_REJECTED');
    }
  }

  async #assertPrecondition(
    account: ConnectorAccountRef,
    taskGid: string,
    expectedModifiedAt: string,
  ): Promise<void> {
    const response = await this.#request({
      method: 'GET',
      path: `/tasks/${encodeURIComponent(taskGid)}`,
      query: {
        opt_fields: 'gid,modified_at,workspace.gid,memberships.project.gid',
      },
      account,
    });
    if (response.status !== 200) providerError(response);
    const data = responseData(response);
    this.#assertObjectScope('task', data);
    if (data.modified_at !== expectedModifiedAt) {
      throw new AsanaConnectorError('ASANA_PRECONDITION_STALE');
    }
  }

  #effectRequest(
    account: ConnectorAccountRef,
    artifact: EffectExecutionArtifact,
    payload: AsanaEffectPayload,
  ): AsanaRequest {
    if (payload.kind === 'create_task') {
      return {
        method: 'POST',
        path: '/tasks',
        account,
        operationId: artifact.stableIdempotencyKey,
        body: {
          data: {
            workspace: payload.workspaceGid,
            ...(payload.projectGid === undefined
              ? {}
              : { projects: [payload.projectGid] }),
            ...mappedFields(payload),
          },
        },
      };
    }
    const headers = {
      'if-unmodified-since': payload.precondition?.modifiedAt ?? '',
    };
    return payload.kind === 'update_task'
      ? {
          method: 'PUT',
          path: `/tasks/${encodeURIComponent(payload.taskGid)}`,
          headers,
          account,
          operationId: artifact.stableIdempotencyKey,
          body: { data: mappedFields(payload) },
        }
      : {
          method: 'POST',
          path: `/tasks/${encodeURIComponent(payload.taskGid)}/stories`,
          headers,
          account,
          operationId: artifact.stableIdempotencyKey,
          body: { data: mappedFields(payload) },
        };
  }

  #effectResult(response: AsanaResponse): ProviderSendResult {
    const now = this.#options.clock.now();
    if (response.status >= 200 && response.status < 300) {
      try {
        return providerSendResultSchema.parse({
          outcome: 'accepted',
          providerResponseHash: sha256(response.body),
          providerCorrelation: getString(responseData(response), 'gid'),
          observedAt: now,
        });
      } catch {
        return providerSendResultSchema.parse({
          outcome: 'acceptance_unknown',
          providerResponseHash: sha256(response.body),
          reasonCode: 'accepted_response_missing_gid',
          observedAt: now,
        });
      }
    }
    if ([400, 401, 403, 404, 409, 412, 422, 429].includes(response.status)) {
      return providerSendResultSchema.parse({
        outcome: 'rejected',
        providerResponseHash: sha256(response.body),
        reasonCode:
          response.status === 412
            ? 'precondition_failed'
            : `http_${response.status}`,
        observedAt: now,
      });
    }
    return providerSendResultSchema.parse({
      outcome: 'acceptance_unknown',
      providerResponseHash: sha256(response.body),
      reasonCode: `http_${response.status}_outcome_unknown`,
      observedAt: now,
    });
  }

  #assertObjectScope(
    kind: WorkObjectRef['kind'],
    data: Record<string, unknown>,
  ): void {
    const workspace = nestedWorkspaceGid(data);
    const projectGids = [
      ...nestedGids(data.projects),
      ...nestedGids(data.memberships),
      ...(data.target !== null && typeof data.target === 'object'
        ? [
            ...nestedGids((data.target as Record<string, unknown>).projects),
            ...nestedGids((data.target as Record<string, unknown>).memberships),
          ]
        : []),
    ];
    const workspaceAllowed = workspace === this.#options.scope.workspaceGid;
    const projectAllowed =
      this.#options.scope.projectGids.length === 0 ||
      (kind === 'project'
        ? this.#options.scope.projectGids.includes(getString(data, 'gid'))
        : projectGids.some((gid) =>
            this.#options.scope.projectGids.includes(gid),
          ));
    if (!workspaceAllowed || !projectAllowed) {
      throw new AsanaConnectorError(
        `ASANA_${kind.toUpperCase()}_SCOPE_REJECTED`,
      );
    }
  }

  #assertCurrentAccountRef(account: ConnectorAccountRef): void {
    if (account.accountId !== this.#options.currentSnapshot.accountId) {
      throw new AsanaConnectorError('ASANA_ACCOUNT_SNAPSHOT_MISMATCH');
    }
  }

  #assertSameAccountRef(
    left: ConnectorAccountRef,
    right: ConnectorAccountRef,
  ): void {
    if (canonicalJson(left) !== canonicalJson(right)) {
      throw new AsanaConnectorError('ASANA_ACCOUNT_REF_SUBSTITUTION');
    }
  }

  #request(request: AsanaRequest): Promise<AsanaResponse> {
    return this.#options.transport.request(freezeDeep(request));
  }
}

export function createAsanaWorkManagementConnector(
  options: AsanaConnectorOptions,
): WorkManagementConnector {
  const implementation = new AsanaWorkManagementConnector(options);
  return Object.freeze({
    connectorKind: implementation.connectorKind,
    descriptor: implementation.descriptor.bind(implementation),
    authorizationStrategy:
      implementation.authorizationStrategy.bind(implementation),
    beginAuthorization: implementation.beginAuthorization.bind(implementation),
    completeAuthorization:
      implementation.completeAuthorization.bind(implementation),
    validateConnection: implementation.validateConnection.bind(implementation),
    subscribe: implementation.subscribe.bind(implementation),
    renewSubscription: implementation.renewSubscription.bind(implementation),
    poll: implementation.poll.bind(implementation),
    fetchObject: implementation.fetchObject.bind(implementation),
    execute: implementation.execute.bind(implementation),
    reconcileEffect: implementation.reconcileEffect.bind(implementation),
  });
}
