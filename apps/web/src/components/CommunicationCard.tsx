import { useState } from 'react';
import type { CommunicationDto } from '../lib/trpc-client.js';

export interface CommunicationCardProps {
  communication: CommunicationDto;
  busy: boolean;
  onApprove: (commId: string) => void;
  onEdit: (commId: string, newBody: string) => void;
  onReject: (commId: string) => void;
  onDismiss: (commId: string) => void;
  onSupplyContext: (commId: string, text: string) => void;
  error?: string;
}

const STATUS_COLORS: Partial<Record<CommunicationDto['status'], string>> = {
  drafted: '#b45309',
  awaiting_approval: '#b45309',
  answered: '#15803d',
  dismissed: '#6b7280',
  needs_context: '#b91c1c',
};

function counterpart(communication: CommunicationDto): string {
  const others = communication.participants.filter((p) => p.role === 'to' || p.role === 'from');
  return others.map((p) => p.displayName ?? p.id).join(', ') || '(unknown)';
}

/**
 * One communication's approve/edit/reject/dismiss/supply-context surface (Task 6, design.md §7/§8:
 * "minimal approval UI ... does NOT need to be pretty ... must be functionally usable by a stranger
 * end-to-end"). Every button calls straight through to the tRPC procedures passed in via props —
 * no business logic here (design.md §7: "business rules never in the prompt or the frontend").
 */
export function CommunicationCard(props: CommunicationCardProps) {
  const {
    communication: c,
    busy,
    onApprove,
    onEdit,
    onReject,
    onDismiss,
    onSupplyContext,
    error,
  } = props;
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState(c.draft?.body ?? '');
  const [contextText, setContextText] = useState('');

  const canApprove = c.status === 'drafted' || c.status === 'awaiting_approval';
  // `approved` with no `sentMessageId` yet is a record whose send failed after a prior approval
  // claimed it (approval-service.ts's retry-after-failed-send path) — surfacing a retry action
  // here is what makes that recovery reachable from the UI, not just the API directly.
  const canRetrySend = c.status === 'approved' && !c.sentMessageId;
  const canDismiss = c.status === 'drafted' || c.status === 'recommended';
  const needsContext = c.status === 'needs_context';

  return (
    <div
      style={{
        border: '1px solid #d1d5db',
        borderRadius: 8,
        padding: '1rem',
        marginBottom: '1rem',
        background: '#fff',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>{counterpart(c)}</strong>
        <span
          style={{
            fontSize: '0.75rem',
            fontWeight: 600,
            color: STATUS_COLORS[c.status] ?? '#374151',
            textTransform: 'uppercase',
          }}
        >
          {c.status}
        </span>
      </div>
      <div style={{ fontSize: '0.8rem', color: '#6b7280', margin: '0.25rem 0' }}>
        {c.channelType} · {new Date(c.ts).toLocaleString()} · commId {c.commId}
      </div>

      {c.recommendation && (
        <div style={{ margin: '0.5rem 0', fontSize: '0.9rem' }}>
          <div>
            <strong>Recommendation:</strong> {c.recommendation.actionType} (confidence{' '}
            {c.recommendation.confidence.toFixed(2)})
          </div>
          <div style={{ color: '#4b5563' }}>{c.recommendation.rationale}</div>
        </div>
      )}

      <div style={{ margin: '0.5rem 0', fontSize: '0.9rem', whiteSpace: 'pre-wrap' }}>
        <strong>Original message:</strong>
        <div style={{ color: '#374151' }}>{c.body}</div>
      </div>

      {c.draft && !editing && (
        <div style={{ margin: '0.5rem 0', fontSize: '0.9rem', whiteSpace: 'pre-wrap' }}>
          <strong>Draft reply:</strong>
          <div style={{ color: '#374151' }}>{c.draft.body}</div>
        </div>
      )}

      {c.draft && editing && (
        <div style={{ margin: '0.5rem 0' }}>
          <textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            rows={5}
            style={{ width: '100%', fontFamily: 'inherit', fontSize: '0.9rem' }}
          />
        </div>
      )}

      {c.sentMessageId && (
        <div style={{ fontSize: '0.8rem', color: '#15803d' }}>
          Sent — provider message id {c.sentMessageId}
        </div>
      )}

      {needsContext && (
        <div style={{ margin: '0.5rem 0' }}>
          <textarea
            placeholder="Supply the missing context…"
            value={contextText}
            onChange={(e) => setContextText(e.target.value)}
            rows={2}
            style={{ width: '100%', fontFamily: 'inherit', fontSize: '0.9rem' }}
          />
        </div>
      )}

      {error && (
        <div style={{ color: '#b91c1c', fontSize: '0.85rem', margin: '0.25rem 0' }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
        {canApprove && !editing && (
          <button disabled={busy} onClick={() => onApprove(c.commId)}>
            Approve &amp; send
          </button>
        )}
        {canRetrySend && (
          <button disabled={busy} onClick={() => onApprove(c.commId)}>
            Retry send (previous attempt failed)
          </button>
        )}
        {c.draft && canApprove && !editing && (
          <button disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        {editing && (
          <>
            <button
              disabled={busy}
              onClick={() => {
                onEdit(c.commId, draftBody);
                setEditing(false);
              }}
            >
              Save edit
            </button>
            <button disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        )}
        {canApprove && !editing && (
          <button disabled={busy} onClick={() => onReject(c.commId)}>
            Reject (re-draft)
          </button>
        )}
        {canDismiss && (
          <button disabled={busy} onClick={() => onDismiss(c.commId)}>
            Dismiss
          </button>
        )}
        {needsContext && (
          <button
            disabled={busy || contextText.trim().length === 0}
            onClick={() => {
              onSupplyContext(c.commId, contextText);
              setContextText('');
            }}
          >
            Supply context
          </button>
        )}
      </div>
    </div>
  );
}
