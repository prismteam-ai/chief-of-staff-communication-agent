import { useMemo, useState } from 'react';
import type { ActionType } from '@chief-of-staff/shared';
import type { CommunicationDto } from '../lib/trpc-client.js';

/**
 * The recommended-actions view (README L36, design.md §8): every communication carrying a
 * recommendation, with its `actionType`/`confidence`/`rationale`, filterable by action type and
 * sortable by confidence or timestamp. Data comes straight from `metrics.listRecommendedActions`
 * (server-side filtered to `recommendation !== undefined` and account-scoped) — filtering/sorting
 * here is pure display convenience over an already-scoped list, not a security boundary.
 */

export interface RecommendedActionsViewProps {
  communications?: CommunicationDto[];
  loading: boolean;
  error?: string;
}

type SortKey = 'confidence-desc' | 'confidence-asc' | 'newest' | 'oldest';

function counterpart(c: CommunicationDto): string {
  const others = c.participants.filter((p) => p.role === 'to' || p.role === 'from');
  return others.map((p) => p.displayName ?? p.id).join(', ') || '(unknown)';
}

export function RecommendedActionsView(props: RecommendedActionsViewProps) {
  const { communications, loading, error } = props;
  const [actionFilter, setActionFilter] = useState<ActionType | 'all'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('newest');

  const filteredSorted = useMemo(() => {
    const list = (communications ?? []).filter(
      (c) => c.recommendation && (actionFilter === 'all' || c.recommendation.actionType === actionFilter),
    );
    const sorted = [...list];
    switch (sortKey) {
      case 'confidence-desc':
        sorted.sort((a, b) => (b.recommendation?.confidence ?? 0) - (a.recommendation?.confidence ?? 0));
        break;
      case 'confidence-asc':
        sorted.sort((a, b) => (a.recommendation?.confidence ?? 0) - (b.recommendation?.confidence ?? 0));
        break;
      case 'oldest':
        sorted.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
        break;
      case 'newest':
      default:
        sorted.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
        break;
    }
    return sorted;
  }, [communications, actionFilter, sortKey]);

  const actionTypes = useMemo(() => {
    const set = new Set<ActionType>();
    for (const c of communications ?? []) {
      if (c.recommendation) set.add(c.recommendation.actionType);
    }
    return [...set].sort();
  }, [communications]);

  if (error) {
    return <p style={{ color: '#b91c1c' }}>Failed to load recommended actions: {error}</p>;
  }

  return (
    <section data-testid="recommended-actions-view">
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <label>
          Action type{' '}
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value as ActionType | 'all')}
          >
            <option value="all">All</option>
            {actionTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort by{' '}
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="confidence-desc">Confidence (high to low)</option>
            <option value="confidence-asc">Confidence (low to high)</option>
          </select>
        </label>
      </div>

      {loading && !communications && <p style={{ color: '#6b7280' }}>Loading…</p>}
      {!loading && filteredSorted.length === 0 && (
        <p style={{ color: '#6b7280' }}>No recommended actions match this filter.</p>
      )}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {filteredSorted.map((c) => (
          <li
            key={c.commId}
            data-testid="recommended-action-row"
            style={{
              border: '1px solid #d1d5db',
              borderRadius: 8,
              padding: '0.75rem 1rem',
              marginBottom: '0.75rem',
              background: '#fff',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <strong>{counterpart(c)}</strong>
              <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                {c.channelType} · {new Date(c.ts).toLocaleString()}
              </span>
            </div>
            {c.recommendation && (
              <div style={{ marginTop: '0.35rem', fontSize: '0.9rem' }}>
                <span
                  style={{
                    display: 'inline-block',
                    background: '#eef2ff',
                    color: '#3730a3',
                    borderRadius: 4,
                    padding: '0.1rem 0.5rem',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    marginRight: '0.5rem',
                  }}
                >
                  {c.recommendation.actionType}
                </span>
                <span style={{ color: '#4b5563' }}>
                  confidence {c.recommendation.confidence.toFixed(2)}
                </span>
                <div style={{ color: '#374151', marginTop: '0.25rem' }}>
                  {c.recommendation.rationale}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
