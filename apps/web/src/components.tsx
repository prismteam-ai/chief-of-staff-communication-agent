import type { ReactNode } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  FileText,
  Inbox,
  Link2,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import type { CapabilityMode, CommunicationStatus } from './data.js';

export function ModeChip({
  mode,
  testId,
}: {
  readonly mode: CapabilityMode;
  readonly testId?: string;
}) {
  const labels: Record<CapabilityMode, string> = {
    live: 'Live',
    recorded: 'Recorded evidence',
    fixture: 'Fixture',
    blocked: 'Blocked',
  };

  return (
    <span className={`mode-chip mode-chip--${mode}`} data-testid={testId}>
      <Circle aria-hidden="true" size={7} fill="currentColor" />
      {labels[mode]}
    </span>
  );
}

export function StatusChip({
  status,
}: {
  readonly status: CommunicationStatus;
}) {
  const config: Record<
    CommunicationStatus,
    { readonly label: string; readonly Icon: LucideIcon }
  > = {
    overdue: { label: 'Overdue', Icon: AlertTriangle },
    pending: { label: 'Pending', Icon: Clock3 },
    answered: { label: 'Answered', Icon: Check },
    context: { label: 'Needs context', Icon: Link2 },
    resolved: { label: 'Resolved', Icon: Archive },
  };
  const { label, Icon } = config[status];

  return (
    <span className={`status-chip status-chip--${status}`}>
      <Icon aria-hidden="true" size={13} />
      {label}
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action === undefined ? null : (
        <div className="page-action">{action}</div>
      )}
    </header>
  );
}

export function EmptyState({ filter }: { readonly filter: string }) {
  return (
    <div className="empty-state" role="status">
      <Archive aria-hidden="true" size={25} />
      <h3>No {filter} communications</h3>
      <p>Change the status filter to review another deterministic queue.</p>
    </div>
  );
}

export function AttachmentCard() {
  return (
    <article className="attachment-card" data-testid="attachment-risk-register">
      <span className="icon-tile" aria-hidden="true">
        <FileText size={18} />
      </span>
      <div>
        <strong>pilot-risk-register.pdf</strong>
        <span>PDF · 1.8 MB · Malware scan: clean</span>
      </div>
      <Link
        className="quiet-icon"
        to="/evidence#retrieval"
        aria-label="Open attachment evidence details"
      >
        <ArrowUpRight size={17} aria-hidden="true" />
      </Link>
    </article>
  );
}

export function QueueIcon({
  status,
}: {
  readonly status: CommunicationStatus;
}) {
  return (
    <span className={`queue-icon queue-icon--${status}`} aria-hidden="true">
      {status === 'answered' ? <Check size={16} /> : <Inbox size={16} />}
    </span>
  );
}

export function InlineLink({
  children,
  to,
}: {
  readonly children: ReactNode;
  readonly to: string;
}) {
  return (
    <Link className="inline-link" to={to}>
      {children}
      <ChevronRight aria-hidden="true" size={14} />
    </Link>
  );
}
