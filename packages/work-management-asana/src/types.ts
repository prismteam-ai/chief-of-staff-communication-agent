import type { EffectExecutionArtifact } from '@chief/contracts/approval';
import type {
  AuthorizationCallback,
  ConnectorAccount,
  ConnectorAccountRef,
  ConnectorSnapshot,
} from '@chief/contracts/connectors';

export type AsanaObjectKind = 'task' | 'project' | 'milestone' | 'comment';

export interface AsanaScope {
  readonly workspaceGid: string;
  readonly projectGids: readonly string[];
  readonly pollingResourceGids: readonly string[];
}

export interface AsanaRequest {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly account: ConnectorAccountRef;
  readonly operationId?: string;
}

export interface AsanaResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface AsanaTransport {
  request(request: AsanaRequest): Promise<AsanaResponse>;
  reconcileEffect?(
    account: ConnectorAccountRef,
    artifact: EffectExecutionArtifact,
    payload: AsanaEffectPayload,
  ): Promise<AsanaReconciliationResult>;
}

export type AsanaReconciliationResult =
  | Readonly<{ outcome: 'accepted'; gid: string; response: unknown }>
  | Readonly<{ outcome: 'proven_nonacceptance'; response: unknown }>
  | Readonly<{ outcome: 'unknown'; reasonCode: string; response?: unknown }>;

export interface AsanaAuthorizationAdapter {
  completeAuthorization(
    callback: AuthorizationCallback,
  ): Promise<ConnectorAccount>;
}

export interface AsanaCreateTaskPayload {
  readonly kind: 'create_task';
  readonly workspaceGid: string;
  readonly projectGid?: string;
  readonly fields: Readonly<{
    name: string;
    notes?: string;
    assignee?: string;
    dueOn?: string;
  }>;
}

export interface AsanaUpdateTaskPayload {
  readonly kind: 'update_task';
  readonly taskGid: string;
  readonly fields: Readonly<{
    name?: string;
    notes?: string;
    assignee?: string;
    dueOn?: string | null;
    completed?: boolean;
  }>;
  readonly precondition: Readonly<{ modifiedAt: string }>;
}

export interface AsanaCreateCommentPayload {
  readonly kind: 'create_comment';
  readonly taskGid: string;
  readonly text: string;
  readonly precondition?: Readonly<{ modifiedAt: string }>;
}

export type AsanaEffectPayload =
  AsanaCreateTaskPayload | AsanaUpdateTaskPayload | AsanaCreateCommentPayload;

export interface AsanaEffectPayloadStore {
  loadExactPayload(
    artifact: EffectExecutionArtifact,
  ): Promise<AsanaEffectPayload>;
}

export interface AsanaClock {
  now(): string;
}

export interface AsanaConnectorOptions {
  readonly clientId: string;
  readonly scope: AsanaScope;
  readonly currentSnapshot: ConnectorSnapshot;
  readonly transport: AsanaTransport;
  readonly authorization: AsanaAuthorizationAdapter;
  readonly effectPayloads: AsanaEffectPayloadStore;
  readonly webhookVerificationKey: string;
  readonly webhookTargetUrl: string;
  readonly clock: AsanaClock;
}

export interface AsanaWebhookEvent {
  readonly action: 'added' | 'changed' | 'deleted' | 'removed' | 'undeleted';
  readonly resource: Readonly<{
    gid: string;
    resource_type: string;
    resource_subtype?: string;
  }>;
  readonly parent?: Readonly<{ gid: string; resource_type: string }>;
  readonly user?: Readonly<{ gid: string; resource_type: 'user' }>;
  readonly created_at: string;
}

export interface AsanaWebhookBatch {
  readonly events: readonly AsanaWebhookEvent[];
}

export interface AsanaCompactEvent {
  readonly eventId: string;
  readonly action: AsanaWebhookEvent['action'];
  readonly kind: AsanaObjectKind;
  readonly gid: string;
  readonly createdAt: string;
}
