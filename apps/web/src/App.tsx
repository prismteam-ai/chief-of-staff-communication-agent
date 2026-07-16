import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CommunicationState } from '@chief-of-staff/shared';
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

/**
 * The full dashboard (Task 8, design.md §8): metrics / recommended-actions / drafts-awaiting-
 * approval / connect-channel views, plus the Task 6 approval-queue view kept as-is (extended, not
 * discarded — brief: "EXTEND into full dashboard, don't discard"). A simple tab nav switches
 * between them; each view fetches its own account-scoped data through `trpc-client.ts`.
 *
 * Auth (Task 8 brief constraint 3): still no real session auth — `accountId`/`userId` remain plain
 * inputs (a demo-user selector below), persisted to localStorage for convenience. The permission
 * boundary is NOT this UI's job: every tRPC procedure (communications, metrics, accounts) calls
 * `assertAccountAccess` against the accounts table server-side, so typing a different `userId`/
 * `accountId` here only ever succeeds if the API's own ownership lookup agrees — proven by the
 * account-scoping tests in `apps/api/src/services/metrics-service.test.ts` and the router
 * integration tests. Two named demo-user presets are offered as a convenience; see
 * `docs/setup.md`/the task report for the second demo user's provisioning status.
 */

const DEFAULT_API_URL = (import.meta.env.VITE_API_URL ?? '').trim();

interface DemoUserPreset {
  label: string;
  userId: string;
  accountId: string;
}

const DEMO_USER_PRESETS: DemoUserPreset[] = [
  { label: 'demo-alex (Gmail)', userId: 'demo-alex', accountId: 'acct-gmail-demoalex775' },
];

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

function usePersistedState(key: string, initial: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? initial);
  useEffect(() => {
    localStorage.setItem(key, value);
  }, [key, value]);
  return [value, setValue];
}

export function App() {
  const [apiUrl, setApiUrl] = usePersistedState('cos.apiUrl', DEFAULT_API_URL);
  const [accountId, setAccountId] = usePersistedState(
    'cos.accountId',
    DEMO_USER_PRESETS[0]!.accountId,
  );
  const [userId, setUserId] = usePersistedState('cos.userId', DEMO_USER_PRESETS[0]!.userId);
  const [activeTab, setActiveTab] = useState<TabKey>('metrics');
  const [statusFilter, setStatusFilter] = useState<CommunicationState | 'all'>('all');

  const client = useMemo(() => (apiUrl ? createApiClient(apiUrl) : undefined), [apiUrl]);

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

  const refreshQueue = useCallback(async () => {
    if (!client) return;
    setQueueLoading(true);
    setQueueError(undefined);
    try {
      const result = await client.listCommunications({
        accountId,
        userId,
        status: statusFilter === 'all' ? undefined : statusFilter,
      });
      setCommunications(result);
    } catch (error) {
      setQueueError(error instanceof TrpcError ? error.message : String(error));
    } finally {
      setQueueLoading(false);
    }
  }, [client, accountId, userId, statusFilter]);

  const refreshMetrics = useCallback(async () => {
    if (!client) return;
    setMetricsLoading(true);
    setMetricsError(undefined);
    try {
      setMetrics(await client.getDashboardMetrics({ accountId, userId }));
    } catch (error) {
      setMetricsError(error instanceof TrpcError ? error.message : String(error));
    } finally {
      setMetricsLoading(false);
    }
  }, [client, accountId, userId]);

  const refreshRecommended = useCallback(async () => {
    if (!client) return;
    setRecommendedLoading(true);
    setRecommendedError(undefined);
    try {
      setRecommended(await client.listRecommendedActions({ accountId, userId }));
    } catch (error) {
      setRecommendedError(error instanceof TrpcError ? error.message : String(error));
    } finally {
      setRecommendedLoading(false);
    }
  }, [client, accountId, userId]);

  const refreshDrafts = useCallback(async () => {
    if (!client) return;
    setDraftsLoading(true);
    setDraftsError(undefined);
    try {
      setDrafts(await client.listDraftsAwaitingApproval({ accountId, userId }));
    } catch (error) {
      setDraftsError(error instanceof TrpcError ? error.message : String(error));
    } finally {
      setDraftsLoading(false);
    }
  }, [client, accountId, userId]);

  const refreshAccounts = useCallback(async () => {
    if (!client) return;
    setAccountsLoading(true);
    setAccountsError(undefined);
    try {
      setAccounts(await client.listConnectedAccounts({ userId }));
    } catch (error) {
      setAccountsError(error instanceof TrpcError ? error.message : String(error));
    } finally {
      setAccountsLoading(false);
    }
  }, [client, userId]);

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
      const message = error instanceof TrpcError ? error.message : String(error);
      setActionErrors((prev) => ({ ...prev, [commId]: message }));
    } finally {
      setBusyCommId(undefined);
    }
  }

  function applyDemoUser(preset: DemoUserPreset) {
    setUserId(preset.userId);
    setAccountId(preset.accountId);
  }

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
        Communication volume, recommended actions, and approvals for one connected account at a time
        — every view below is scoped server-side to the signed-in user&apos;s own accounts.
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
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <label>
              Demo user{' '}
              <select
                data-testid="demo-user-select"
                value={userId}
                onChange={(e) => {
                  const preset = DEMO_USER_PRESETS.find((p) => p.userId === e.target.value);
                  if (preset) applyDemoUser(preset);
                }}
              >
                {DEMO_USER_PRESETS.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.label}
                  </option>
                ))}
                {!DEMO_USER_PRESETS.some((p) => p.userId === userId) && (
                  <option value={userId}>{userId} (custom)</option>
                )}
              </select>
            </label>
          </div>
          <label>
            Account id
            <input
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              style={{ width: '100%' }}
            />
          </label>
          <label>
            User id
            <input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              style={{ width: '100%' }}
            />
          </label>
        </div>
      </fieldset>

      {!apiUrl && <p style={{ color: '#b91c1c' }}>Set the API URL above to load the dashboard.</p>}

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
              borderBottom: activeTab === tab.key ? '2px solid #4338ca' : '2px solid transparent',
              background: 'none',
              fontWeight: activeTab === tab.key ? 700 : 400,
              cursor: 'pointer',
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {apiUrl && activeTab === 'metrics' && (
        <MetricsView metrics={metrics} loading={metricsLoading} error={metricsError} />
      )}

      {apiUrl && activeTab === 'recommended' && (
        <RecommendedActionsView
          communications={recommended}
          loading={recommendedLoading}
          error={recommendedError}
        />
      )}

      {apiUrl && activeTab === 'drafts' && (
        <DraftsAwaitingApprovalView
          communications={drafts}
          loading={draftsLoading}
          error={draftsError}
          busyCommId={busyCommId}
          actionErrors={actionErrors}
          onApprove={(commId) =>
            void runAction(commId, () => client!.approveDraft({ commId, userId }))
          }
          onEdit={(commId, newBody) =>
            void runAction(commId, () => client!.editDraft({ commId, userId, newBody }))
          }
          onReject={(commId) =>
            void runAction(commId, () => client!.rejectDraft({ commId, userId }))
          }
          onDismiss={(commId) => void runAction(commId, () => client!.dismiss({ commId, userId }))}
          onSupplyContext={(commId, text) =>
            void runAction(commId, () => client!.supplyContext({ commId, userId, text }))
          }
        />
      )}

      {apiUrl && activeTab === 'channels' && (
        <ChannelsView accounts={accounts} loading={accountsLoading} error={accountsError} />
      )}

      {apiUrl && activeTab === 'queue' && (
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
          {!queueLoading && !queueError && communications.length === 0 && (
            <p style={{ color: '#6b7280' }}>No communications match this filter.</p>
          )}

          {communications.map((c) => (
            <CommunicationCard
              key={c.commId}
              communication={c}
              busy={busyCommId === c.commId}
              error={actionErrors[c.commId] || undefined}
              onApprove={(commId) =>
                void runAction(commId, () => client!.approveDraft({ commId, userId }))
              }
              onEdit={(commId, newBody) =>
                void runAction(commId, () => client!.editDraft({ commId, userId, newBody }))
              }
              onReject={(commId) =>
                void runAction(commId, () => client!.rejectDraft({ commId, userId }))
              }
              onDismiss={(commId) =>
                void runAction(commId, () => client!.dismiss({ commId, userId }))
              }
              onSupplyContext={(commId, text) =>
                void runAction(commId, () => client!.supplyContext({ commId, userId, text }))
              }
            />
          ))}
        </section>
      )}
    </main>
  );
}
