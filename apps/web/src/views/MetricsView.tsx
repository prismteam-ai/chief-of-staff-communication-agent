import type { DashboardMetrics } from '../lib/trpc-client.js';

/**
 * The metrics view (README L35, design.md §8): communication volume, response-status breakdown,
 * overdue count, pending-approvals count, channel breakdown, and response-time metrics. Every
 * number here is a prop straight from `metrics.getDashboardMetrics` — no client-side aggregation
 * (Task 8 brief constraint 4: aggregation happens server-side in the Lambda, this component only
 * renders the already-computed shape).
 */

export interface MetricsViewProps {
  metrics?: DashboardMetrics;
  loading: boolean;
  error?: string;
}

const TILE_STYLE: React.CSSProperties = {
  border: '1px solid #d1d5db',
  borderRadius: 8,
  padding: '1rem',
  background: '#fff',
  minWidth: 160,
};

const TILE_LABEL_STYLE: React.CSSProperties = {
  fontSize: '0.75rem',
  color: '#6b7280',
  textTransform: 'uppercase',
  fontWeight: 600,
};

const TILE_VALUE_STYLE: React.CSSProperties = {
  fontSize: '1.75rem',
  fontWeight: 700,
  marginTop: '0.25rem',
};

function Tile(props: { label: string; value: string; accent?: string; testId: string }) {
  return (
    <div style={TILE_STYLE} data-testid={props.testId}>
      <div style={TILE_LABEL_STYLE}>{props.label}</div>
      <div style={{ ...TILE_VALUE_STYLE, color: props.accent }}>{props.value}</div>
    </div>
  );
}

function formatSeconds(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remSeconds}s`;
}

export function MetricsView(props: MetricsViewProps) {
  const { metrics, loading, error } = props;

  if (error) {
    return <p style={{ color: '#b91c1c' }}>Failed to load metrics: {error}</p>;
  }
  if (loading && !metrics) {
    return <p style={{ color: '#6b7280' }}>Loading metrics…</p>;
  }
  if (!metrics) {
    return <p style={{ color: '#6b7280' }}>No metrics available.</p>;
  }

  const statusEntries = Object.entries(metrics.statusBreakdown).filter(([, count]) => count > 0);
  const channelEntries = Object.entries(metrics.channelBreakdown);

  return (
    <section data-testid="metrics-view">
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        <Tile testId="tile-volume" label="Total volume" value={String(metrics.totalVolume)} />
        <Tile
          testId="tile-overdue"
          label="Overdue (>5min)"
          value={String(metrics.overdueCount)}
          accent={metrics.overdueCount > 0 ? '#b91c1c' : undefined}
        />
        <Tile
          testId="tile-pending"
          label="Pending approvals"
          value={String(metrics.pendingApprovalsCount)}
          accent={metrics.pendingApprovalsCount > 0 ? '#b45309' : undefined}
        />
        <Tile testId="tile-handled" label="Handled" value={String(metrics.handledCount)} />
        <Tile
          testId="tile-avg-response"
          label="Avg response time"
          value={formatSeconds(metrics.responseTime.averageSeconds)}
        />
        <Tile
          testId="tile-under-5"
          label="Answered under 5min"
          value={String(metrics.responseTime.underFiveMinutesCount)}
          accent="#15803d"
        />
      </div>

      <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
        <div data-testid="status-breakdown">
          <h3 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Response status</h3>
          {statusEntries.length === 0 && <p style={{ color: '#6b7280' }}>No data yet.</p>}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {statusEntries.map(([status, count]) => (
              <li
                key={status}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  fontSize: '0.9rem',
                  padding: '0.15rem 0',
                }}
              >
                <span>{status}</span>
                <strong>{count}</strong>
              </li>
            ))}
          </ul>
        </div>

        <div data-testid="channel-breakdown">
          <h3 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Channel breakdown</h3>
          {channelEntries.length === 0 && <p style={{ color: '#6b7280' }}>No data yet.</p>}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {channelEntries.map(([channel, count]) => (
              <li
                key={channel}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  fontSize: '0.9rem',
                  padding: '0.15rem 0',
                }}
              >
                <span>{channel}</span>
                <strong>{count}</strong>
              </li>
            ))}
          </ul>
        </div>

        <div data-testid="response-time-stats">
          <h3 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Response-time metrics</h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.9rem' }}>
            <li>Sample count: {metrics.responseTime.sampleCount}</li>
            <li>Average: {formatSeconds(metrics.responseTime.averageSeconds)}</li>
            <li>Median: {formatSeconds(metrics.responseTime.medianSeconds)}</li>
            <li>Under 5-minute goal: {metrics.responseTime.underFiveMinutesCount}</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
