import { useCallback, useEffect, useMemo, useState } from 'react';
import { CHANNEL_TYPES, type ChannelType, type CommunicationState } from '@chief-of-staff/shared';
import {
  createApiClient,
  TrpcError,
  type CommunicationDto,
  type ConnectedAccountDto,
  type DashboardMetrics,
} from './lib/trpc-client.js';
import { CommunicationCard } from './components/CommunicationCard.js';
import { MetricsView } from './views/MetricsView.js';
import { RecommendedActionsView } from './views/RecommendedActionsView.js';
import { DraftsAwaitingApprovalView } from './views/DraftsAwaitingApprovalView.js';
import { ChannelsView } from './views/ChannelsView.js';
import { LoginView } from './views/LoginView.js';

/**
 * The full dashboard (Task 8, design.md §8): metrics / recommended-actions / drafts-awaiting-
 * approval / connect-channel views, plus the Task 6 approval-queue view kept as-is (extended, not
 * discarded — brief: "EXTEND into full dashboard, don't discard"). A simple tab nav switches
 * between them; each view fetches its own account-scoped data through `trpc-client.ts`.
 *
 * Auth (Task 8.5 — closes the Task 8 v0 gap): the dashboard used to send a plain, client-supplied
 * `userId` on every call — nothing stopped a stranger from typing `userId: "demo-alex"` and acting
 * as that user, even though every procedure's own `assertAccountAccess` check was real. There is no
 * demo-user selector anymore: a real login screen (`LoginView`) collects a username/password,
 * calls `auth.login`, and the server verifies the credential BEFORE minting a session token — the
 * SAME token machinery Task 11 built for the MCP server (`McpAuthService`). The token is persisted
 * to localStorage and sent as `Authorization: Bearer <token>` on every subsequent call
 * (`trpc-client.ts`'s `getToken`); no procedure input carries `userId` anymore, so there is nothing
 * left for a client to forge. A 401 (missing/invalid/forged/expired token) drops the session and
 * shows the login screen again.
 *
 * Unified multi-account inbox (slowking fix 1): the dashboard used to require picking ONE
 * `accountId` up front (a text input under "Connection") — a user with both a Gmail and a WhatsApp
 * account could only ever see one channel at a time, contradicting the assignment's core intent of
 * "every communication across ALL channels in ONE unified inbox". That selector is gone. Every view
 * now calls its procedure with NO `accountId`, which the server resolves to "aggregate across every
 * account the signed-in user owns" (`MetricsService.loadUserScoped` / `ApprovalService.
 * listCommunications`, both server-side off the token's `userId` — never a client-supplied list).
 * The optional per-channel `channelFilter` dropdown below narrows the already-unified result set
 * client-side (a display filter over data the user already legitimately received), not a
 * pre-aggregation account picker.
 */

const DEFAULT_API_URL = (import.meta.env.VITE_API_URL ?? '').trim();

const STATUS_FILTERS: { label: string; value: CommunicationState | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Drafted', value: 'drafted' },
  { label: 'Awaiting approval', value: 'awaiting_approval' },
  { label: 'Needs context', value: 'needs_context' },
  { label: 'Awaiting re-processing', value: 'awaiting_reprocess' },
  { label: 'Answered', value: 'answered' },
  { label: 'Dismissed', value: 'dismissed' },
];

const TABS = [
  { key: 'metrics', label: 'Metrics' },
  { key: 'recommended', label: 'Recommended actions' },
  { key: 'drafts', label: 'Drafts awaiting approval' },
  { key: 'queue', label: 'Approval queue (all)' },
  { key: 'channels', label: 'Connect a channel' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

const SESSION_TOKEN_KEY = 'cos.sessionToken';
const SESSION_USER_ID_KEY = 'cos.sessionUserId';

function usePersistedState(key: string, initial: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? initial);
  useEffect(() => {
    localStorage.setItem(key, value);
  }, [key, value]);
  return [value, setValue];
}

export function App() {
  const [apiUrl, setApiUrl] = usePersistedState('cos.apiUrl', DEFAULT_API_URL);
  // Unified inbox (slowking fix 1): no account picker — `channelFilter` is a client-side display
  // filter over the already-unified (all-owned-accounts) result set, not a pre-aggregation choice.
  const [channelFilter, setChannelFilter] = useState<ChannelType | 'all'>('all');

  // --- Session (Task 8.5): a session token replaces the old demo-user selector entirely. ---
  const [sessionToken, setSessionToken] = useState<string | undefined>(
    () => localStorage.getItem(SESSION_TOKEN_KEY) ?? undefined,
  );
  const [sessionUserId, setSessionUserId] = useState<string | undefined>(
    () => localStorage.getItem(SESSION_USER_ID_KEY) ?? undefined,
  );
  const [loginError, setLoginError] = useState<string | undefined>();
  const [loginBusy, setLoginBusy] = useState(false);

  const [activeTab, setActiveTab] = useState<TabKey>('metrics');
  const [statusFilter, setStatusFilter] = useState<CommunicationState | 'all'>('all');

  const client = useMemo(
    () => (apiUrl ? createApiClient(apiUrl, () => sessionToken) : undefined),
    [apiUrl, sessionToken],
  );

  function clearSession() {
    setSessionToken(undefined);
    setSessionUserId(undefined);
    localStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(SESSION_USER_ID_KEY);
  }

  /** Every data-loading callback below funnels its error through this — a 401 means the token is
   * missing/invalid/forged/expired, so the session is dropped and the login screen reappears
   * (brief constraint 3: "On 401/invalid token -> show login again"), rather than showing a raw
   * error message next to a dashboard the user can no longer actually use. */
  function handleLoadError(error: unknown): string | undefined {
    if (error instanceof TrpcError) {
      if (error.isUnauthorized) {
        clearSession();
        return undefined;
      }
      return error.message;
    }
    return String(error);
  }

  async function handleLogin(username: string, password: string) {
    if (!client) return;
    setLoginBusy(true);
    setLoginError(undefined);
    try {
      const result = await client.login({ username, password });
      setSessionToken(result.token);
      setSessionUserId(result.userId);
      localStorage.setItem(SESSION_TOKEN_KEY, result.token);
      localStorage.setItem(SESSION_USER_ID_KEY, result.userId);
    } catch (error) {
      setLoginError(error instanceof TrpcError ? error.message : String(error));
    } finally {
      setLoginBusy(false);
    }
  }

  // --- Approval queue (Task 6, unchanged behavior) ---
  const [communications, setCommunications] = useState<CommunicationDto[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | undefined>();

  // --- Metrics view ---
  const [metrics, setMetrics] = useState<DashboardMetrics | undefined>();
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState<string | undefined>();

  // --- Recommended-actions view ---
  const [recommended, setRecommended] = useState<CommunicationDto[] | undefined>();
  const [recommendedLoading, setRecommendedLoading] = useState(false);
  const [recommendedError, setRecommendedError] = useState<string | undefined>();

  // --- Drafts-awaiting-approval view ---
  const [drafts, setDrafts] = useState<CommunicationDto[] | undefined>();
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [draftsError, setDraftsError] = useState<string | undefined>();

  // --- Connect-channel wizard ---
  const [accounts, setAccounts] = useState<ConnectedAccountDto[] | undefined>();
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | undefined>();

  // --- Shared action-in-flight state (approve/edit/reject/dismiss/supply-context) ---
  const [busyCommId, setBusyCommId] = useState<string | undefined>();
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  // No `accountId` on any of these four (slowking fix 1): every call aggregates across every
  // account the signed-in user owns, resolved server-side from the session token.
  const refreshQueue = useCallback(async () => {
    if (!client || !sessionToken) return;
    setQueueLoading(true);
    setQueueError(undefined);
    try {
      const result = await client.listCommunications({
        status: statusFilter === 'all' ? undefined : statusFilter,
      });
      setCommunications(result);
    } catch (error) {
      setQueueError(handleLoadError(error));
    } finally {
      setQueueLoading(false);
    }
  }, [client, sessionToken, statusFilter]);

  const refreshMetrics = useCallback(async () => {
    if (!client || !sessionToken) return;
    setMetricsLoading(true);
    setMetricsError(undefined);
    try {
      setMetrics(await client.getDashboardMetrics());
    } catch (error) {
      setMetricsError(handleLoadError(error));
    } finally {
      setMetricsLoading(false);
    }
  }, [client, sessionToken]);

  const refreshRecommended = useCallback(async () => {
    if (!client || !sessionToken) return;
    setRecommendedLoading(true);
    setRecommendedError(undefined);
    try {
      setRecommended(await client.listRecommendedActions());
    } catch (error) {
      setRecommendedError(handleLoadError(error));
    } finally {
      setRecommendedLoading(false);
    }
  }, [client, sessionToken]);

  const refreshDrafts = useCallback(async () => {
    if (!client || !sessionToken) return;
    setDraftsLoading(true);
    setDraftsError(undefined);
    try {
      setDrafts(await client.listDraftsAwaitingApproval());
    } catch (error) {
      setDraftsError(handleLoadError(error));
    } finally {
      setDraftsLoading(false);
    }
  }, [client, sessionToken]);

  const refreshAccounts = useCallback(async () => {
    if (!client || !sessionToken) return;
    setAccountsLoading(true);
    setAccountsError(undefined);
    try {
      setAccounts(await client.listConnectedAccounts());
    } catch (error) {
      setAccountsError(handleLoadError(error));
    } finally {
      setAccountsLoading(false);
    }
  }, [client, sessionToken]);

  // Load the active tab's data whenever it becomes active or the connection/filter changes.
  useEffect(() => {
    if (activeTab === 'queue') void refreshQueue();
    if (activeTab === 'metrics') void refreshMetrics();
    if (activeTab === 'recommended') void refreshRecommended();
    if (activeTab === 'drafts') void refreshDrafts();
    if (activeTab === 'channels') void refreshAccounts();
  }, [activeTab, refreshQueue, refreshMetrics, refreshRecommended, refreshDrafts, refreshAccounts]);

  async function runAction(commId: string, action: () => Promise<CommunicationDto>) {
    if (!client) return;
    setBusyCommId(commId);
    setActionErrors((prev) => ({ ...prev, [commId]: '' }));
    try {
      const updated = await action();
      setCommunications((prev) => prev.map((c) => (c.commId === commId ? updated : c)));
      setDrafts((prev) => prev?.map((c) => (c.commId === commId ? updated : c)));
      // A resolved draft (approved/dismissed/etc.) no longer belongs in the awaiting-approval list.
      setDrafts((prev) =>
        prev?.filter(
          (c) => c.commId !== commId || ['drafted', 'awaiting_approval'].includes(updated.status),
        ),
      );
    } catch (error) {
      if (error instanceof TrpcError && error.isUnauthorized) {
        clearSession();
        return;
      }
      const message = error instanceof TrpcError ? error.message : String(error);
      setActionErrors((prev) => ({ ...prev, [commId]: message }));
    } finally {
      setBusyCommId(undefined);
    }
  }

  const isLoggedIn = Boolean(sessionToken && sessionUserId);

  // The optional per-channel filter (slowking fix 1): a client-side narrowing of the already-
  // unified (all-owned-accounts) result set the server returned — never a re-scoping request.
  function byChannel<T extends { channelType: ChannelType }>(list: T[] | undefined): T[] | undefined {
    if (!list || channelFilter === 'all') return list;
    return list.filter((c) => c.channelType === channelFilter);
  }
  const filteredRecommended = byChannel(recommended);
  const filteredDrafts = byChannel(drafts);
  const filteredCommunications = byChannel(communications) ?? [];

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        maxWidth: 1100,
        margin: '0 auto',
      }}
    >
      <h1>Chief of Staff — Dashboard</h1>
      <p style={{ color: '#4b5563' }}>
        One unified inbox across every channel you&apos;ve connected — every view below aggregates
        server-side across ALL of the signed-in user&apos;s own accounts, resolved from your session
        token, never from anything typed into this page. Use the channel filter to narrow to one
        channel.
      </p>

      <fieldset style={{ marginBottom: '1.5rem', border: '1px solid #d1d5db', borderRadius: 8 }}>
        <legend style={{ padding: '0 0.5rem' }}>Connection</legend>
        <div style={{ display: 'grid', gap: '0.5rem', padding: '0.5rem 1rem 1rem' }}>
          <label>
            API URL
            <input
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://…execute-api…amazonaws.com"
              style={{ width: '100%' }}
            />
          </label>
          {isLoggedIn && (
            <div
              style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}
            >
              <span data-testid="session-user">
                Signed in as <strong>{sessionUserId}</strong>
              </span>
              <button type="button" data-testid="logout-button" onClick={() => clearSession()}>
                Log out
              </button>
            </div>
          )}
          <label>
            Channel filter
            <select
              data-testid="channel-filter"
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value as ChannelType | 'all')}
              style={{ width: '100%' }}
            >
              <option value="all">All channels (unified inbox)</option>
              {CHANNEL_TYPES.map((channel) => (
                <option key={channel} value={channel}>
                  {channel}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>

      {!apiUrl && <p style={{ color: '#b91c1c' }}>Set the API URL above to load the dashboard.</p>}

      {apiUrl && !isLoggedIn && (
        <LoginView onLogin={handleLogin} busy={loginBusy} error={loginError} />
      )}

      {apiUrl && isLoggedIn && (
        <>
          <nav
            role="tablist"
            style={{
              display: 'flex',
              gap: '0.25rem',
              borderBottom: '1px solid #d1d5db',
              marginBottom: '1.5rem',
              flexWrap: 'wrap',
            }}
          >
            {TABS.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={activeTab === tab.key}
                data-testid={`tab-${tab.key}`}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  padding: '0.5rem 0.9rem',
                  border: 'none',
                  borderBottom:
                    activeTab === tab.key ? '2px solid #4338ca' : '2px solid transparent',
                  background: 'none',
                  fontWeight: activeTab === tab.key ? 700 : 400,
                  cursor: 'pointer',
                }}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {activeTab === 'metrics' && (
            <MetricsView metrics={metrics} loading={metricsLoading} error={metricsError} />
          )}

          {activeTab === 'recommended' && (
            <RecommendedActionsView
              communications={filteredRecommended}
              loading={recommendedLoading}
              error={recommendedError}
            />
          )}

          {activeTab === 'drafts' && (
            <DraftsAwaitingApprovalView
              communications={filteredDrafts}
              loading={draftsLoading}
              error={draftsError}
              busyCommId={busyCommId}
              actionErrors={actionErrors}
              onApprove={(commId) => void runAction(commId, () => client!.approveDraft({ commId }))}
              onEdit={(commId, newBody) =>
                void runAction(commId, () => client!.editDraft({ commId, newBody }))
              }
              onReject={(commId) => void runAction(commId, () => client!.rejectDraft({ commId }))}
              onDismiss={(commId) => void runAction(commId, () => client!.dismiss({ commId }))}
              onSupplyContext={(commId, text) =>
                void runAction(commId, () => client!.supplyContext({ commId, text }))
              }
            />
          )}

          {activeTab === 'channels' && (
            <ChannelsView accounts={accounts} loading={accountsLoading} error={accountsError} />
          )}

          {activeTab === 'queue' && (
            <section data-testid="approval-queue-view">
              <div style={{ marginBottom: '1rem' }}>
                <label>
                  Status filter{' '}
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as CommunicationState | 'all')}
                  >
                    {STATUS_FILTERS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>{' '}
                <button onClick={() => void refreshQueue()} disabled={queueLoading}>
                  {queueLoading ? 'Loading…' : 'Refresh'}
                </button>
              </div>

              {queueError && <p style={{ color: '#b91c1c' }}>Failed to load: {queueError}</p>}
              {!queueLoading && !queueError && filteredCommunications.length === 0 && (
                <p style={{ color: '#6b7280' }}>No communications match this filter.</p>
              )}

              {filteredCommunications.map((c) => (
                <CommunicationCard
                  key={c.commId}
                  communication={c}
                  busy={busyCommId === c.commId}
                  error={actionErrors[c.commId] || undefined}
                  onApprove={(commId) =>
                    void runAction(commId, () => client!.approveDraft({ commId }))
                  }
                  onEdit={(commId, newBody) =>
                    void runAction(commId, () => client!.editDraft({ commId, newBody }))
                  }
                  onReject={(commId) =>
                    void runAction(commId, () => client!.rejectDraft({ commId }))
                  }
                  onDismiss={(commId) => void runAction(commId, () => client!.dismiss({ commId }))}
                  onSupplyContext={(commId, text) =>
                    void runAction(commId, () => client!.supplyContext({ commId, text }))
                  }
                />
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}
