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

export class TrpcError extends Error {
  constructor(
    message: string,
    public readonly procedure: string,
  ) {
    super(message);
    this.name = 'TrpcError';
  }
}

interface TrpcSuccessEnvelope<T> {
  result: { data: T };
}
interface TrpcErrorEnvelope {
  error: { message: string; code?: string };
}

function isErrorEnvelope(body: unknown): body is TrpcErrorEnvelope {
  return typeof body === 'object' && body !== null && 'error' in body;
}

export function createApiClient(baseUrl: string) {
  async function query<T>(procedure: string, input: unknown): Promise<T> {
    const url = `${baseUrl.replace(/\/$/, '')}/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;
    const response = await fetch(url, { method: 'GET' });
    const body: unknown = await response.json();
    if (!response.ok || isErrorEnvelope(body)) {
      const message = isErrorEnvelope(body) ? body.error.message : `HTTP ${response.status}`;
      throw new TrpcError(message, procedure);
    }
    return (body as TrpcSuccessEnvelope<T>).result.data;
  }

  async function mutate<T>(procedure: string, input: unknown): Promise<T> {
    const url = `${baseUrl.replace(/\/$/, '')}/${procedure}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body: unknown = await response.json();
    if (!response.ok || isErrorEnvelope(body)) {
      const message = isErrorEnvelope(body) ? body.error.message : `HTTP ${response.status}`;
      throw new TrpcError(message, procedure);
    }
    return (body as TrpcSuccessEnvelope<T>).result.data;
  }

  return {
    listCommunications: (input: {
      accountId: string;
      userId: string;
      status?: CommunicationState;
    }) => query<CommunicationDto[]>('communications.listCommunications', input),
    getCommunication: (input: { commId: string; userId: string }) =>
      query<CommunicationDto>('communications.getCommunication', input),
    approveDraft: (input: { commId: string; userId: string }) =>
      mutate<CommunicationDto>('communications.approveDraft', input),
    editDraft: (input: { commId: string; userId: string; newBody: string }) =>
      mutate<CommunicationDto>('communications.editDraft', input),
    rejectDraft: (input: { commId: string; userId: string }) =>
      mutate<CommunicationDto>('communications.rejectDraft', input),
    dismiss: (input: { commId: string; userId: string }) =>
      mutate<CommunicationDto>('communications.dismiss', input),
    supplyContext: (input: { commId: string; userId: string; text: string }) =>
      mutate<CommunicationDto>('communications.supplyContext', input),

    // --- Task 8 dashboard views: server-side aggregation/reads, account-scoped (design.md §8) ---
    getDashboardMetrics: (input: { accountId: string; userId: string }) =>
      query<DashboardMetrics>('metrics.getDashboardMetrics', input),
    listRecommendedActions: (input: { accountId: string; userId: string }) =>
      query<CommunicationDto[]>('metrics.listRecommendedActions', input),
    listDraftsAwaitingApproval: (input: { accountId: string; userId: string }) =>
      query<CommunicationDto[]>('metrics.listDraftsAwaitingApproval', input),
    listConnectedAccounts: (input: { userId: string }) =>
      query<ConnectedAccountDto[]>('accounts.listConnectedAccounts', input),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
