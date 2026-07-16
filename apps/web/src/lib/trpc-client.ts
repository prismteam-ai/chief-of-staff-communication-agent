import type {
  ActionType,
  ChannelType,
  CommunicationState,
  Draft,
  Recommendation,
  TransitionRecord,
} from '@chief-of-staff/shared';

/**
 * Minimal tRPC HTTP client for the approval loop (Task 6, design.md §8: "minimal approval UI").
 * Plain `fetch` against the AWS Lambda tRPC adapter's HTTP contract — GET `?input=<json>` for
 * queries, POST JSON body for mutations, `{result:{data:...}}` on success / `{error:{message}}` on
 * failure — the same contract `scripts/smoke.ts` already exercises against `health.check`. A full
 * `@trpc/client` + React Query setup is Task 8's dashboard scope; this task's UI only needs to be
 * "functionally usable by a stranger end-to-end" (brief constraint 4), so a dependency-light typed
 * fetch wrapper is the proportionate choice here.
 *
 * Auth (Task 8.5): `createApiClient` takes a `getToken` callback instead of the caller threading
 * `userId` through every method — every request now sends `Authorization: Bearer <token>` (when a
 * token is available) and NO procedure input carries `userId` anymore. The server resolves
 * `userId` from the verified token; a client can no longer act as an arbitrary user by typing a
 * different `userId` into the input, because there is no `userId` input left to type.
 */

export interface Participant {
  id: string;
  displayName?: string;
  role: 'from' | 'to' | 'cc' | 'bcc';
}

export interface CommunicationDto {
  commId: string;
  accountId: string;
  channelType: ChannelType;
  status: CommunicationState;
  threadKey: string;
  participants: Participant[];
  ts: string;
  body: string;
  recommendation?: Recommendation & { actionType: ActionType };
  draft?: Draft;
  transitions?: TransitionRecord[];
  sentMessageId?: string;
}

/** Every state's count, zero-filled — mirrors `MetricsService.getDashboardMetrics`'s server shape
 * (Task 8, design.md §8) so the UI never has to guard a missing key. A plain type alias (not an
 * `interface extends Record<...>`) — the latter loses its index signature for `Object.entries`
 * under this project's `noUncheckedIndexedAccess` tsconfig, widening entry values to `unknown`. */
export type StatusBreakdown = Record<CommunicationState, number>;

export interface ResponseTimeStats {
  sampleCount: number;
  averageSeconds: number | null;
  medianSeconds: number | null;
  underFiveMinutesCount: number;
}

export interface DashboardMetrics {
  totalVolume: number;
  statusBreakdown: StatusBreakdown;
  channelBreakdown: Partial<Record<ChannelType, number>>;
  overdueCount: number;
  pendingApprovalsCount: number;
  handledCount: number;
  responseTime: ResponseTimeStats;
}

/** Connect-channel wizard row (README L12) — no credential/secret reference, per the server DTO. */
export interface ConnectedAccountDto {
  accountId: string;
  channelType: ChannelType;
  displayName: string;
  createdAt: string;
}

export interface LoginResult {
  token: string;
  userId: string;
}

export class TrpcError extends Error {
  constructor(
    message: string,
    public readonly procedure: string,
    /** `true` when the server responded UNAUTHORIZED (missing/invalid/forged bearer token) — the
     * caller (`App.tsx`) uses this to drop back to the login screen rather than showing a generic
     * error, satisfying "On 401/invalid token -> show login again." */
    public readonly isUnauthorized: boolean = false,
  ) {
    super(message);
    this.name = 'TrpcError';
  }
}

interface TrpcSuccessEnvelope<T> {
  result: { data: T };
}
interface TrpcErrorEnvelope {
  error: { message: string; code?: string; data?: { httpStatus?: number } };
}

function isErrorEnvelope(body: unknown): body is TrpcErrorEnvelope {
  return typeof body === 'object' && body !== null && 'error' in body;
}

/** `getToken` is read fresh on every call (not captured once) so a token obtained after the
 * client was constructed — or cleared on logout — is always the one actually sent. */
export function createApiClient(baseUrl: string, getToken: () => string | undefined = () => undefined) {
  function authHeaders(): Record<string, string> {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function throwIfError(response: Response, body: unknown, procedure: string): void {
    if (response.ok && !isErrorEnvelope(body)) return;
    const message = isErrorEnvelope(body) ? body.error.message : `HTTP ${response.status}`;
    const code = isErrorEnvelope(body) ? body.error.code : undefined;
    const isUnauthorized = response.status === 401 || code === 'UNAUTHORIZED';
    throw new TrpcError(message, procedure, isUnauthorized);
  }

  async function query<T>(procedure: string, input?: unknown): Promise<T> {
    const url =
      input === undefined
        ? `${baseUrl.replace(/\/$/, '')}/${procedure}`
        : `${baseUrl.replace(/\/$/, '')}/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;
    const response = await fetch(url, { method: 'GET', headers: { ...authHeaders() } });
    const body: unknown = await response.json();
    throwIfError(response, body, procedure);
    return (body as TrpcSuccessEnvelope<T>).result.data;
  }

  async function mutate<T>(procedure: string, input: unknown): Promise<T> {
    const url = `${baseUrl.replace(/\/$/, '')}/${procedure}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(input),
    });
    const body: unknown = await response.json();
    throwIfError(response, body, procedure);
    return (body as TrpcSuccessEnvelope<T>).result.data;
  }

  return {
    // --- Auth (Task 8.5): the ONE procedure that never sends a bearer token — there isn't one yet. ---
    login: (input: { username: string; password: string }) =>
      mutate<LoginResult>('auth.login', input),

    listCommunications: (input: { accountId: string; status?: CommunicationState }) =>
      query<CommunicationDto[]>('communications.listCommunications', input),
    getCommunication: (input: { commId: string }) =>
      query<CommunicationDto>('communications.getCommunication', input),
    approveDraft: (input: { commId: string }) =>
      mutate<CommunicationDto>('communications.approveDraft', input),
    editDraft: (input: { commId: string; newBody: string }) =>
      mutate<CommunicationDto>('communications.editDraft', input),
    rejectDraft: (input: { commId: string }) =>
      mutate<CommunicationDto>('communications.rejectDraft', input),
    dismiss: (input: { commId: string }) => mutate<CommunicationDto>('communications.dismiss', input),
    supplyContext: (input: { commId: string; text: string }) =>
      mutate<CommunicationDto>('communications.supplyContext', input),

    // --- Task 8 dashboard views: server-side aggregation/reads, account-scoped (design.md §8) ---
    getDashboardMetrics: (input: { accountId: string }) =>
      query<DashboardMetrics>('metrics.getDashboardMetrics', input),
    listRecommendedActions: (input: { accountId: string }) =>
      query<CommunicationDto[]>('metrics.listRecommendedActions', input),
    listDraftsAwaitingApproval: (input: { accountId: string }) =>
      query<CommunicationDto[]>('metrics.listDraftsAwaitingApproval', input),
    listConnectedAccounts: () => query<ConnectedAccountDto[]>('accounts.listConnectedAccounts'),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
