import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CommunicationState } from '@chief-of-staff/shared';
import { createApiClient, TrpcError, type CommunicationDto } from './lib/trpc-client.js';
import { CommunicationCard } from './components/CommunicationCard.js';

/**
 * The Task 6 approval loop UI (design.md §7/§8): a working list of communications with per-item
 * approve/edit/reject/dismiss/supply-context — "does NOT need to be pretty ... must be functionally
 * usable by a stranger end-to-end" (brief constraint 4). The full metrics/response-time/permission-
 * boundary dashboard views are Task 8.
 *
 * Auth (brief constraint 4): no real session auth exists yet — `accountId`/`userId` are plain text
 * inputs, persisted to localStorage for convenience, defaulting to the seeded demo account so a
 * reviewer sees data immediately without typing anything. The account-ownership guard is enforced
 * SERVER-SIDE regardless (every tRPC procedure calls `assertAccountAccess` against the accounts
 * table) — a stranger typing someone else's userId here is rejected by the API, not by this UI.
 */

const DEFAULT_API_URL = (import.meta.env.VITE_API_URL ?? '').trim();
const DEFAULT_ACCOUNT_ID = 'acct-gmail-demoalex775';
const DEFAULT_USER_ID = 'demo-alex';

const STATUS_FILTERS: { label: string; value: CommunicationState | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Drafted', value: 'drafted' },
  { label: 'Awaiting approval', value: 'awaiting_approval' },
  { label: 'Needs context', value: 'needs_context' },
  { label: 'Answered', value: 'answered' },
  { label: 'Dismissed', value: 'dismissed' },
];

function usePersistedState(key: string, initial: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? initial);
  useEffect(() => {
    localStorage.setItem(key, value);
  }, [key, value]);
  return [value, setValue];
}

export function App() {
  const [apiUrl, setApiUrl] = usePersistedState('cos.apiUrl', DEFAULT_API_URL);
  const [accountId, setAccountId] = usePersistedState('cos.accountId', DEFAULT_ACCOUNT_ID);
  const [userId, setUserId] = usePersistedState('cos.userId', DEFAULT_USER_ID);
  const [statusFilter, setStatusFilter] = useState<CommunicationState | 'all'>('all');

  const [communications, setCommunications] = useState<CommunicationDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | undefined>();
  const [busyCommId, setBusyCommId] = useState<string | undefined>();
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  const client = useMemo(() => (apiUrl ? createApiClient(apiUrl) : undefined), [apiUrl]);

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setListError(undefined);
    try {
      const result = await client.listCommunications({
        accountId,
        userId,
        status: statusFilter === 'all' ? undefined : statusFilter,
      });
      setCommunications(result);
    } catch (error) {
      setListError(error instanceof TrpcError ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [client, accountId, userId, statusFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function runAction(commId: string, action: () => Promise<CommunicationDto>) {
    if (!client) return;
    setBusyCommId(commId);
    setActionErrors((prev) => ({ ...prev, [commId]: '' }));
    try {
      const updated = await action();
      setCommunications((prev) => prev.map((c) => (c.commId === commId ? updated : c)));
    } catch (error) {
      const message = error instanceof TrpcError ? error.message : String(error);
      setActionErrors((prev) => ({ ...prev, [commId]: message }));
    } finally {
      setBusyCommId(undefined);
    }
  }

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        maxWidth: 900,
        margin: '0 auto',
      }}
    >
      <h1>Chief of Staff — Approval queue</h1>
      <p style={{ color: '#4b5563' }}>
        Review recommended replies, approve to send, edit, reject to re-draft, dismiss no-reply
        items, or supply context for low-confidence items.
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
          <div>
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
            <button onClick={() => void refresh()} disabled={!apiUrl || loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>
      </fieldset>

      {!apiUrl && <p style={{ color: '#b91c1c' }}>Set the API URL above to load communications.</p>}
      {listError && <p style={{ color: '#b91c1c' }}>Failed to load: {listError}</p>}
      {apiUrl && !loading && !listError && communications.length === 0 && (
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
          onDismiss={(commId) => void runAction(commId, () => client!.dismiss({ commId, userId }))}
          onSupplyContext={(commId, text) =>
            void runAction(commId, () => client!.supplyContext({ commId, userId, text }))
          }
        />
      ))}
    </main>
  );
}
