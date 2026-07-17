import type { CommunicationDto } from '../lib/trpc-client.js';
import { CommunicationCard } from '../components/CommunicationCard.js';

/**
 * The drafts-awaiting-approval view (README L37, design.md §8): drafts pending approval with the
 * full approve/edit/reject/dismiss/supply-context surface, reusing the Task 6 `CommunicationCard`
 * unmodified — same component, same server-enforced transitions, just scoped to the
 * `metrics.listDraftsAwaitingApproval` result instead of the unfiltered `listCommunications` feed.
 */

export interface DraftsAwaitingApprovalViewProps {
  communications?: CommunicationDto[];
  loading: boolean;
  error?: string;
  busyCommId?: string;
  actionErrors: Record<string, string>;
  onApprove: (commId: string) => void;
  onEdit: (commId: string, newBody: string) => void;
  onReject: (commId: string) => void;
  onDismiss: (commId: string) => void;
  onSupplyContext: (commId: string, text: string) => void;
}

export function DraftsAwaitingApprovalView(props: DraftsAwaitingApprovalViewProps) {
  const { communications, loading, error, busyCommId, actionErrors } = props;

  if (error) {
    return <p style={{ color: '#b91c1c' }}>Failed to load drafts: {error}</p>;
  }

  return (
    <section data-testid="drafts-awaiting-approval-view">
      {loading && !communications && <p style={{ color: '#6b7280' }}>Loading…</p>}
      {!loading && communications && communications.length === 0 && (
        <p style={{ color: '#6b7280' }}>No drafts awaiting approval right now.</p>
      )}

      {(communications ?? []).map((c) => (
        <CommunicationCard
          key={c.commId}
          communication={c}
          busy={busyCommId === c.commId}
          error={actionErrors[c.commId] || undefined}
          onApprove={props.onApprove}
          onEdit={props.onEdit}
          onReject={props.onReject}
          onDismiss={props.onDismiss}
          onSupplyContext={props.onSupplyContext}
        />
      ))}
    </section>
  );
}
