import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  BarChart3,
  BellRing,
  BookOpenCheck,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  CloudCog,
  Code2,
  ExternalLink,
  FileCheck2,
  Filter,
  Gauge,
  Inbox,
  Info,
  Link2,
  ListChecks,
  LockKeyhole,
  LogOut,
  MessageSquareText,
  Paperclip,
  PencilLine,
  Plus,
  RefreshCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  TimerReset,
  UserRoundCheck,
  Waypoints,
} from 'lucide-react';
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';

import { createApiClient, type ApiClient } from '@chief/api-client';
import {
  createBrowserApi,
  type BrowserApi,
  type BrowserApprovalStatus,
  type BrowserDashboardMetrics,
  type BrowserExecutionStatus,
} from '@chief/browser-api';
import {
  attachmentIdSchema,
  messageRevisionIdSchema,
  proposalIdSchema,
  threadIdSchema,
} from '@chief/contracts';
import type {
  CommunicationDetailView,
  CommunicationSummaryView,
  ConnectorStatusView,
  CitedDraftResult,
  ProductHealthResponse,
  ActionRecommendation,
  ThreadContextView,
  WorkObjectFact,
} from '@chief/contracts';

import {
  AttachmentCard,
  EmptyState,
  InlineLink,
  ModeChip,
  PageHeader,
  QueueIcon,
  StatusChip,
} from './components.js';
import {
  channelBreakdown,
  citations,
  communications,
  connectors,
  initialDraft,
  revisedDraft,
  type CapabilityMode,
  type CommunicationFixture,
  type CommunicationStatus,
  type ConnectorFixture,
} from './data.js';
import {
  browserLoginHref,
  isAuthenticationRequired,
  isBrowserNetworkFailure,
  resolveBrowserApiBaseUrl,
  revokeBrowserSession,
} from './auth.js';

type ApiState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly health: ProductHealthResponse }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

type InboxFilter = 'all' | CommunicationStatus;
type ProjectionSource = 'checking' | 'hosted_durable' | 'local_fallback';

interface KnownProposalReference {
  readonly proposalId: string;
  readonly kind: 'draft_reply' | 'asana_action';
  readonly threadId: string;
  readonly messageRevisionId: string;
  readonly subject: string;
  readonly actionType?: string;
}

interface RecommendedThread {
  readonly communication: CommunicationSummaryView;
  readonly recommendation: ActionRecommendation;
}

type RecommendedActionsState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly items: readonly RecommendedThread[];
      readonly inspectedCount: number;
      readonly unavailableCount: number;
    }
  | { readonly kind: 'unavailable'; readonly message: string };

interface VerifiedProposal {
  readonly reference: KnownProposalReference;
  readonly approval: BrowserApprovalStatus;
  readonly execution: BrowserExecutionStatus;
}

type ProposalQueueState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly items: readonly VerifiedProposal[];
      readonly unavailableCount: number;
    };

interface DurableApprovalReceipt {
  readonly kind: 'effect_disabled';
  readonly operationId: string;
  readonly artifactHash: string;
  readonly stableIdempotencyKey: string;
  readonly observedAt: string;
}

type DurableApprovalState =
  | { readonly kind: 'not_prepared' }
  | { readonly kind: 'preparing' }
  | {
      readonly kind: 'pending';
      readonly proposalId: string;
      readonly updatedAt: string;
      readonly notice?: string;
    }
  | {
      readonly kind: 'approving';
      readonly proposalId: string;
      readonly updatedAt: string;
    }
  | {
      readonly kind: 'approved';
      readonly proposalId: string;
      readonly updatedAt: string;
      readonly receipt: DurableApprovalReceipt;
      readonly recoveredAfterAcknowledgementFailure?: boolean;
    }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'uncertain';
      readonly proposalId: string;
      readonly message: string;
    };

type ApprovalRouteState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly proposalId: string;
      readonly approvalStatus:
        | 'prepared'
        | 'pending_approval'
        | 'approved'
        | 'rejected'
        | 'expired'
        | 'cancelled';
      readonly executionStatus:
        'not_requested' | 'pending_approval' | 'effect_disabled';
      readonly updatedAt: string;
      readonly receipt?: DurableApprovalReceipt;
    };

const hostedEvaluatorRoutes: Readonly<Record<string, string>> = Object.freeze({
  'message-revision-1-1': 'thread-q3-launch',
  'message-revision-2-1': 'thread-board-packet',
});

interface ProductProjection {
  readonly source: ProjectionSource;
  readonly metrics?: BrowserDashboardMetrics;
  readonly communications: readonly CommunicationFixture[];
  readonly hostedCommunications: readonly CommunicationSummaryView[];
  readonly connectors: readonly ConnectorFixture[];
}

const navItems = [
  { to: '/overview', label: 'Overview', Icon: BarChart3 },
  { to: '/inbox', label: 'Inbox', Icon: Inbox },
  { to: '/recommended', label: 'Recommended', Icon: Sparkles },
  { to: '/approvals', label: 'Approvals', Icon: ClipboardCheck },
  { to: '/connections', label: 'Connections', Icon: Waypoints },
  { to: '/evidence', label: 'Evidence & help', Icon: BookOpenCheck },
] as const;

const mobileNavItems = navItems.filter(({ to }) => to !== '/connections');

const conciseRevisionInstruction =
  'Make this draft concise while retaining all cited facts.';

const channelLabels: Readonly<Record<string, string>> = Object.freeze({
  gmail: 'Gmail',
  microsoft_graph: 'Microsoft Graph',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  x: 'X',
  linkedin_archive: 'LinkedIn archive',
  future_demo: 'Demo channel',
});

function formatChannel(channel: string): string {
  return (
    channelLabels[channel] ??
    channel
      .replaceAll('_', ' ')
      .replace(/\b\w/gu, (letter) => letter.toUpperCase())
  );
}

function hostedCommunicationToView(
  communication: CommunicationSummaryView,
): CommunicationFixture {
  const sourceDate = new Date(communication.sourceTimestamp);
  const frozenNow = new Date('2026-07-17T12:00:00.000Z');
  const ageSeconds = Math.max(
    0,
    Math.round((frozenNow.getTime() - sourceDate.getTime()) / 1000),
  );
  const ageMinutes = Math.floor(ageSeconds / 60);
  const remainingSeconds = ageSeconds % 60;

  return {
    id:
      hostedEvaluatorRoutes[communication.messageRevisionId] ??
      communication.messageRevisionId,
    threadId: communication.threadId,
    messageRevisionId: communication.messageRevisionId,
    sender: communication.senderDisplayName ?? 'Unknown sender',
    subject: communication.subject ?? 'Communication without subject',
    excerpt: communication.excerpt,
    channel: formatChannel(communication.channel),
    account: `${communication.accountId} · ${communication.brandId}`,
    status: communication.status,
    received: sourceDate.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }),
    age: `${ageMinutes}m ${String(remainingSeconds).padStart(2, '0')}s`,
    attachmentCount: communication.attachmentCount,
    priority:
      communication.status === 'overdue'
        ? 'critical'
        : communication.status === 'pending'
          ? 'high'
          : 'normal',
  };
}

function formatCapabilityName(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/^./u, (character) => character.toUpperCase());
}

function formatActionType(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replace(/^./u, (character) => character.toUpperCase());
}

async function listAllCommunicationsByStatus(
  api: BrowserApi,
  status: 'pending' | 'overdue',
): Promise<readonly CommunicationSummaryView[]> {
  const items: CommunicationSummaryView[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const result = await api.listCommunications({
      status,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...result.items);
    if (result.nextCursor === undefined) return items;
    if (seenCursors.has(result.nextCursor)) {
      throw new Error('The communication cursor repeated.');
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }

  throw new Error('The bounded communication enumeration was exceeded.');
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index]!);
    }
  };
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => worker()));
  return results;
}

function hostedConnectorToView(
  connector: ConnectorStatusView,
): ConnectorFixture {
  const mode: CapabilityMode =
    connector.runtimeMode === 'live' || connector.runtimeMode === 'live_trial'
      ? 'live'
      : connector.runtimeMode === 'fixture'
        ? 'fixture'
        : connector.runtimeMode === 'sandbox' ||
            connector.runtimeMode === 'virtual_test' ||
            connector.runtimeMode === 'manual'
          ? 'recorded'
          : 'blocked';
  const enabledCapabilities = Object.entries(connector.capabilities)
    .filter(([, enabled]) => enabled)
    .map(([capability]) => formatCapabilityName(capability))
    .slice(0, 4);
  const isTwilio = connector.connectorId === 'twilio-sms';

  return {
    id: connector.connectorId,
    name: connector.displayLabel,
    account: `Hosted ${connector.runtimeMode.replaceAll('_', ' ')} projection`,
    mode,
    detail: isTwilio
      ? 'Synthetic byte-recorded, provider-shaped SMS fixture served by the hosted API; no live Twilio event is claimed.'
      : `Typed hosted ${connector.connectorKind.replaceAll('_', ' ')} projection for ${connector.provider}.`,
    health: `${connector.health} · ${connector.status}`,
    lastSync:
      connector.lastSyncAt === undefined
        ? 'No hosted sync evidence'
        : `Frozen fixture · ${new Date(connector.lastSyncAt).toLocaleString(
            'en-GB',
            { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' },
          )} UTC`,
    capabilities:
      enabledCapabilities.length === 0
        ? ['No enabled capability']
        : enabledCapabilities,
  };
}

function AppShell({
  apiState,
  source,
  pendingApprovalCount,
  loggingOut,
  logoutError,
  onLogout,
  children,
}: {
  readonly apiState: ApiState;
  readonly source: ProjectionSource;
  readonly pendingApprovalCount: number;
  readonly loggingOut: boolean;
  readonly logoutError?: string;
  readonly onLogout: () => void;
  readonly children: React.ReactNode;
}) {
  const location = useLocation();
  const routeLabel =
    navItems.find((item) => location.pathname.startsWith(item.to))?.label ??
    'Communication detail';

  const apiLabel =
    apiState.kind === 'ready'
      ? 'Hosted durable API healthy'
      : apiState.kind === 'checking'
        ? 'Checking hosted API'
        : 'Hosted API unavailable · local fallback';
  const sourceLabel =
    source === 'hosted_durable'
      ? 'Durable hosted evaluator data.'
      : source === 'local_fallback'
        ? 'Local fallback fixture.'
        : 'Checking hosted assessment fixture.';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside className="sidebar">
        <Link className="brand" to="/overview" aria-label="Chief overview">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          <span>
            <strong>Chief</strong>
            <small>Executive communications</small>
          </span>
        </Link>

        <nav className="primary-nav" aria-label="Primary navigation">
          {navItems.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to}>
              <Icon aria-hidden="true" size={19} />
              <span>{label}</span>
              {label === 'Approvals' ? (
                <span
                  className="nav-count"
                  data-testid="nav-pending-approval-count"
                  aria-label={`${pendingApprovalCount} pending approvals`}
                >
                  {pendingApprovalCount}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>

        <section className="sidebar-proof" aria-label="Evaluator mode">
          <div className="sidebar-proof-title">
            <ShieldCheck aria-hidden="true" size={17} />
            <strong>Safe evaluator</strong>
          </div>
          <p>
            Authenticated evaluator · deterministic non-PII seed · durable
            records · external effects disabled.
          </p>
          <ModeChip mode="fixture" testId="capability-mode-session" />
        </section>

        <div className="sidebar-footer">
          <span className={`api-indicator api-indicator--${apiState.kind}`}>
            <span aria-hidden="true" />
            {apiLabel}
          </span>
          <Link to="/evidence#mcp">
            <Code2 aria-hidden="true" size={16} />
            Connect Cursor / MCP
          </Link>
          <button
            className="sidebar-logout"
            type="button"
            onClick={onLogout}
            disabled={loggingOut}
          >
            <LogOut aria-hidden="true" size={16} />
            {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
          {logoutError === undefined ? null : (
            <small className="sidebar-logout-error" role="alert">
              {logoutError}
            </small>
          )}
        </div>
      </aside>

      <div className="app-body">
        <div className="truth-banner" role="status">
          <Info aria-hidden="true" size={16} />
          <span>
            <strong>{sourceLabel}</strong> Workflow records are deterministic
            and non-live. The public API persists bounded retrieval, draft,
            approval, outbox, and receipt state; external provider dispatch is
            disabled.
          </span>
          <Link to="/evidence#capabilities">Inspect evidence</Link>
        </div>
        <header className="mobile-header">
          <Link className="brand" to="/overview">
            <span className="brand-mark" aria-hidden="true">
              C
            </span>
            <strong>Chief</strong>
          </Link>
          <span>{routeLabel}</span>
        </header>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          {mobileNavItems.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} aria-label={label}>
              <Icon aria-hidden="true" size={19} />
              <span>{label === 'Evidence & help' ? 'Evidence' : label}</span>
            </NavLink>
          ))}
        </nav>
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

function BrowserAccessState({
  kind,
  onRetry,
}: {
  readonly kind: 'checking' | 'unauthenticated' | 'unavailable';
  readonly onRetry: () => void;
}) {
  const location = useLocation();
  const loginHref = browserLoginHref(location.pathname);
  return (
    <div className="auth-shell">
      <main className="auth-card" aria-live="polite">
        <span className="auth-mark" aria-hidden="true">
          C
        </span>
        {kind === 'checking' ? (
          <>
            <RefreshCcw
              className="auth-state-icon auth-state-icon--spin"
              aria-hidden="true"
            />
            <p className="eyebrow">Secure evaluator</p>
            <h1>Checking your Chief session</h1>
            <p>Verifying access to the bounded assessment workspace.</p>
          </>
        ) : kind === 'unauthenticated' ? (
          <>
            <LockKeyhole className="auth-state-icon" aria-hidden="true" />
            <p className="eyebrow">Access required</p>
            <h1>Sign in to Chief</h1>
            <p>
              Use the evaluator account to open the durable, non-PII assessment
              workspace. Authentication stays in the hosted identity service.
            </p>
            <a
              className="button button--primary auth-primary-action"
              href={loginHref}
            >
              Sign in securely
              <ArrowRight aria-hidden="true" size={18} />
            </a>
          </>
        ) : (
          <>
            <CloudCog className="auth-state-icon" aria-hidden="true" />
            <p className="eyebrow">Service unavailable</p>
            <h1>Chief could not verify access</h1>
            <p>
              The secure product endpoint did not respond correctly. No local
              fixture has been substituted for the hosted evaluator.
            </p>
            <button
              className="button button--primary auth-primary-action"
              type="button"
              onClick={onRetry}
            >
              <RefreshCcw aria-hidden="true" size={18} />
              Try again
            </button>
          </>
        )}
      </main>
    </div>
  );
}

function OverviewPage({
  projection,
}: {
  readonly projection: ProductProjection;
}) {
  const snapshot = projection.metrics?.snapshot;
  const isHosted = projection.source === 'hosted_durable';
  const totalCommunications =
    projection.metrics?.totalCommunications ?? communications.length;
  const countStatus = (status: CommunicationStatus) =>
    projection.communications.filter((item) => item.status === status).length;
  const pendingCount = snapshot?.pendingCount ?? countStatus('pending');
  const overdueCount = snapshot?.overdueCount ?? countStatus('overdue');
  const answeredCount = snapshot?.answeredCount ?? countStatus('answered');
  const resolvedCount = snapshot?.resolvedCount ?? countStatus('resolved');
  const attentionCount = pendingCount + overdueCount;
  const pendingApprovalCount = projection.metrics?.pendingApprovalCount ?? 0;
  const actionablePercent =
    totalCommunications === 0
      ? 0
      : ((answeredCount + resolvedCount) / totalCommunications) * 100;
  const urgentCommunication =
    projection.communications.find(({ status }) => status === 'overdue') ??
    projection.communications[0];
  const displayedChannelBreakdown: readonly {
    readonly channel: string;
    readonly count: number;
    readonly percent: number;
    readonly mode: CapabilityMode;
  }[] =
    projection.metrics === undefined
      ? channelBreakdown
      : projection.metrics.channelBreakdown.map((item) => ({
          ...item,
          percent:
            totalCommunications === 0
              ? 0
              : Math.round((item.count / totalCommunications) * 100),
          mode: 'fixture',
        }));
  const metrics = [
    {
      id: 'volume',
      label: 'Communications',
      value: totalCommunications.toLocaleString('en-US'),
      note: isHosted ? 'Hosted 7-day fixture corpus' : 'Local fallback corpus',
      Icon: MessageSquareText,
    },
    {
      id: 'pending',
      label: 'Pending',
      value: pendingCount.toLocaleString('en-US'),
      note: `${pendingApprovalCount} awaiting approval`,
      Icon: Clock3,
    },
    {
      id: 'answered',
      label: 'Answered',
      value: answeredCount.toLocaleString('en-US'),
      note: `${resolvedCount.toLocaleString('en-US')} additionally resolved`,
      Icon: CheckCircle2,
    },
    {
      id: 'overdue',
      label: 'Overdue',
      value: overdueCount.toLocaleString('en-US'),
      note: isHosted ? 'Durable hosted seed projection' : '4 critical priority',
      Icon: BellRing,
    },
  ] as const;

  return (
    <div className="page page--overview">
      <PageHeader
        eyebrow="Executive briefing · Friday, 17 July 2026"
        title="Good morning, Alex."
        description={`${attentionCount.toLocaleString('en-US')} communications need attention. The pending and overdue queue is separated from answered and resolved work.`}
        action={
          urgentCommunication === undefined ? null : (
            <Link
              className="button button--primary"
              to={`/inbox/${urgentCommunication.id}`}
            >
              Review urgent thread <ArrowRight aria-hidden="true" size={17} />
            </Link>
          )
        }
      />

      <section
        className="metric-grid"
        aria-label="Communication summary metrics"
      >
        {metrics.map(({ id, label, value, note, Icon }) => (
          <article
            className={`metric-card metric-card--${id}`}
            key={id}
            data-testid={`metric-${id}`}
          >
            <div className="metric-heading">
              <span>{label}</span>
              <Icon aria-hidden="true" size={18} />
            </div>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </section>

      <div className="overview-grid">
        <section
          className="surface priority-queue"
          aria-labelledby="priority-heading"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Priority queue</p>
              <h2 id="priority-heading">Needs your attention</h2>
            </div>
            <Link className="text-link" to="/inbox">
              View all {totalCommunications.toLocaleString('en-US')}
            </Link>
          </div>
          <div className="queue-list">
            {projection.communications.slice(0, 3).map((item) => (
              <Link
                className="queue-row"
                to={`/inbox/${item.id}`}
                key={item.id}
              >
                <QueueIcon status={item.status} />
                <div className="queue-content">
                  <div>
                    <strong>{item.sender}</strong>
                    <span>{item.received}</span>
                  </div>
                  <p>{item.subject}</p>
                  <small>
                    {item.channel} · {item.account}
                  </small>
                </div>
                <StatusChip status={item.status} />
              </Link>
            ))}
          </div>
        </section>

        <section
          className="surface sla-card"
          aria-labelledby="sla-heading"
          data-testid="sla-panel"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Response objective</p>
              <h2 id="sla-heading">Under five minutes</h2>
            </div>
            <Gauge aria-hidden="true" size={20} />
          </div>
          <div className="sla-score">
            <strong>{actionablePercent.toFixed(1)}%</strong>
            <span>answered or resolved in the current projection</span>
          </div>
          <div
            className="progress-track"
            aria-label={`${actionablePercent.toFixed(1)} percent answered or resolved`}
          >
            <span style={{ width: `${actionablePercent}%` }} />
          </div>
          <dl className="mini-stats">
            <div>
              <dt>Median response</dt>
              <dd>
                {snapshot?.responseTimeP50Ms === undefined
                  ? '2m 12s'
                  : `${Math.round(snapshot.responseTimeP50Ms / 1000)}s`}
              </dd>
            </div>
            <div>
              <dt>p95 actionable</dt>
              <dd>
                {snapshot?.responseTimeP95Ms === undefined
                  ? '4m 38s'
                  : `${Math.round(snapshot.responseTimeP95Ms / 1000)}s`}
              </dd>
            </div>
            <div>
              <dt>Human approval wait</dt>
              <dd>1m 04s</dd>
            </div>
          </dl>
          <p className="data-note">
            Frozen fixture window ending 17 Jul 2026 · UTC · source-to-ingress
            and human wait reported separately.
          </p>
        </section>
      </div>

      <div className="overview-grid overview-grid--lower">
        <section
          className="surface"
          aria-labelledby="channels-heading"
          data-testid="channel-breakdown"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Channel mix</p>
              <h2 id="channels-heading">Communication volume</h2>
            </div>
            <span className="period-chip">Last 7 days</span>
          </div>
          <div className="channel-list">
            {displayedChannelBreakdown.map((item) => (
              <div className="channel-row" key={item.channel}>
                <div>
                  <strong>{item.channel}</strong>
                  <ModeChip mode={item.mode} />
                </div>
                <div
                  className="channel-bar"
                  aria-label={`${item.channel}: ${item.count} communications`}
                >
                  <span style={{ width: `${item.percent}%` }} />
                </div>
                <span>{item.count}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="surface" aria-labelledby="actions-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Local static examples</p>
              <h2 id="actions-heading">Demonstration activity</h2>
            </div>
            <Activity aria-hidden="true" size={20} />
          </div>
          <p className="projection-notice" data-testid="activity-source-label">
            Demonstration only · these static activity examples are not part of
            the{' '}
            {isHosted
              ? 'hosted multichannel corpus.'
              : 'local fallback communication records.'}
          </p>
          <ol className="activity-list" data-testid="audit-timeline">
            <li>
              <span className="activity-mark activity-mark--safe">
                <Check size={12} />
              </span>
              <div>
                <strong>Pricing exception acknowledged</strong>
                <p>
                  Demonstration-only effect-disabled receipt · synthetic
                  provider-shaped SMS fixture
                </p>
                <small>09:26 UTC · operation fx-op-3908</small>
              </div>
            </li>
            <li>
              <span className="activity-mark">
                <Link2 size={12} />
              </span>
              <div>
                <strong>Asana follow-up prepared</strong>
                <p>Board metric sensitivity · pending approval</p>
                <small>09:22 UTC · ASANA-FX-882</small>
              </div>
            </li>
            <li>
              <span className="activity-mark">
                <TimerReset size={12} />
              </span>
              <div>
                <strong>Context requested</strong>
                <p>Partner introduction · meeting owner unclear</p>
                <small>09:19 UTC · no external effect</small>
              </div>
            </li>
          </ol>
        </section>
      </div>
    </div>
  );
}

function InboxPage({
  api,
  projection,
}: {
  readonly api: BrowserApi;
  readonly projection: ProductProjection;
}) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [channel, setChannel] = useState('all');
  const [hostedPage, setHostedPage] = useState<{
    readonly kind: 'idle' | 'loading' | 'ready' | 'error';
    readonly items: readonly CommunicationSummaryView[];
    readonly totalCount: number;
    readonly nextCursor?: string;
  }>({ kind: 'idle', items: [], totalCount: 0 });
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedQuery(query.trim()),
      250,
    );
    return () => window.clearTimeout(timeout);
  }, [query]);

  const hostedStatus =
    filter === 'pending' ||
    filter === 'answered' ||
    filter === 'overdue' ||
    filter === 'resolved'
      ? filter
      : undefined;
  const hostedRequestFilters = useMemo(
    () => ({
      ...(hostedStatus === undefined ? {} : { status: hostedStatus }),
      ...(debouncedQuery.length === 0 ? {} : { query: debouncedQuery }),
      ...(channel === 'all' ? {} : { channel }),
    }),
    [channel, debouncedQuery, hostedStatus],
  );
  const hostedRequestKey = JSON.stringify(hostedRequestFilters);
  const hostedRequestKeyRef = useRef(hostedRequestKey);
  const hostedRequestGenerationRef = useRef(0);
  hostedRequestKeyRef.current = hostedRequestKey;

  useEffect(() => {
    const requestGeneration = ++hostedRequestGenerationRef.current;
    if (projection.source !== 'hosted_durable') return;
    let active = true;
    const requestKey = hostedRequestKey;
    setHostedPage((current) => ({
      kind: 'loading',
      items: current.items,
      totalCount: current.totalCount,
      ...(current.nextCursor === undefined
        ? {}
        : { nextCursor: current.nextCursor }),
    }));
    void api
      .listCommunications({
        limit: 100,
        ...hostedRequestFilters,
      })
      .then((result) => {
        if (
          !active ||
          hostedRequestGenerationRef.current !== requestGeneration ||
          hostedRequestKeyRef.current !== requestKey
        )
          return;
        setHostedPage({
          kind: 'ready',
          items: result.items,
          totalCount: result.totalCount,
          ...(result.nextCursor === undefined
            ? {}
            : { nextCursor: result.nextCursor }),
        });
      })
      .catch(() => {
        if (
          !active ||
          hostedRequestGenerationRef.current !== requestGeneration ||
          hostedRequestKeyRef.current !== requestKey
        )
          return;
        setHostedPage((current) => ({
          kind: 'error',
          items: current.items,
          totalCount: current.totalCount,
        }));
      });
    return () => {
      active = false;
    };
  }, [api, hostedRequestFilters, hostedRequestKey, projection.source]);

  const localFiltered = projection.communications.filter((item) => {
    const matchesStatus = filter === 'all' || item.status === filter;
    const normalized = query.trim().toLowerCase();
    const matchesQuery =
      normalized.length === 0 ||
      `${item.sender} ${item.subject} ${item.channel}`
        .toLowerCase()
        .includes(normalized);
    return matchesStatus && matchesQuery;
  });
  const displayed =
    projection.source === 'hosted_durable'
      ? hostedPage.items.map(hostedCommunicationToView)
      : localFiltered;
  const matchingCount =
    projection.source === 'hosted_durable'
      ? hostedPage.totalCount
      : localFiltered.length;
  const channelOptions = projection.metrics?.channelBreakdown ?? [];

  const loadMore = async () => {
    if (
      projection.source !== 'hosted_durable' ||
      hostedPage.nextCursor === undefined ||
      loadingMore
    )
      return;
    const requestKey = hostedRequestKey;
    const requestGeneration = hostedRequestGenerationRef.current;
    const cursor = hostedPage.nextCursor;
    setLoadingMore(true);
    try {
      const result = await api.listCommunications({
        limit: 100,
        cursor,
        ...hostedRequestFilters,
      });
      setHostedPage((current) =>
        hostedRequestGenerationRef.current !== requestGeneration ||
        hostedRequestKeyRef.current !== requestKey ||
        current.nextCursor !== cursor
          ? current
          : {
              kind: 'ready',
              items: [...current.items, ...result.items],
              totalCount: result.totalCount,
              ...(result.nextCursor === undefined
                ? {}
                : { nextCursor: result.nextCursor }),
            },
      );
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow={
          projection.source === 'hosted_durable'
            ? 'Server-authoritative multichannel corpus'
            : 'Local multi-channel demonstration'
        }
        title="Inbox"
        description={
          projection.source === 'hosted_durable'
            ? 'Search and filter the complete deterministic 1,120-message corpus across seven channels. Results are selected and paginated by the typed API.'
            : 'A local fallback demonstration queue with channel-shaped examples. These records are not hosted evidence.'
        }
        action={
          <span className="fixture-summary">
            <ModeChip mode="fixture" />
            {matchingCount.toLocaleString('en-US')}{' '}
            {projection.source === 'hosted_durable'
              ? 'matching hosted records'
              : 'local fallback records'}
          </span>
        }
      />
      <section
        className="surface inbox-surface"
        aria-labelledby="inbox-table-heading"
      >
        <div className="inbox-toolbar">
          <div className="search-control">
            <Search aria-hidden="true" size={17} />
            <label className="sr-only" htmlFor="inbox-search">
              Search communications
            </label>
            <input
              id="inbox-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search person, subject, or channel"
            />
          </div>
          <label className="select-control" htmlFor="inbox-filter">
            <Filter aria-hidden="true" size={16} />
            <span>Status</span>
            <select
              id="inbox-filter"
              data-testid="inbox-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value as InboxFilter)}
            >
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="overdue">Overdue</option>
              {projection.source === 'hosted_durable' ? null : (
                <option value="context">Needs context</option>
              )}
              <option value="answered">Answered</option>
              <option value="resolved">Resolved</option>
            </select>
            <ChevronDown aria-hidden="true" size={15} />
          </label>
          {projection.source === 'hosted_durable' ? (
            <label className="select-control" htmlFor="inbox-channel-filter">
              <Waypoints aria-hidden="true" size={16} />
              <span>Channel</span>
              <select
                id="inbox-channel-filter"
                data-testid="inbox-channel-filter"
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
              >
                <option value="all">All channels</option>
                {channelOptions.map((item) => (
                  <option key={item.channel} value={item.channel}>
                    {formatChannel(item.channel)} ({item.count})
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden="true" size={15} />
            </label>
          ) : null}
        </div>
        <h2 className="sr-only" id="inbox-table-heading">
          Communication queue
        </h2>
        <div className="inbox-heading" aria-hidden="true">
          <span>Communication</span>
          <span>Channel</span>
          <span>Status</span>
          <span>Age</span>
        </div>
        <div className="inbox-list">
          {hostedPage.kind === 'loading' && displayed.length === 0 ? (
            <div className="inbox-loading" role="status">
              Loading authoritative communication results…
            </div>
          ) : displayed.length === 0 ? (
            <EmptyState filter={filter} />
          ) : (
            displayed.map((item) => (
              <button
                className="inbox-row"
                data-testid={`inbox-row-${item.id}`}
                key={item.id}
                type="button"
                onClick={() => {
                  void navigate(`/inbox/${item.id}`, {
                    state: { communication: item },
                  });
                }}
                aria-label={`Open ${item.subject} from ${item.sender}`}
              >
                <div className="sender-cell">
                  <span className="avatar" aria-hidden="true">
                    {item.sender
                      .split(' ')
                      .map((part) => part[0])
                      .join('')}
                  </span>
                  <div>
                    <strong>{item.sender}</strong>
                    <p>{item.subject}</p>
                    <small>{item.excerpt}</small>
                  </div>
                </div>
                <div className="channel-cell">
                  <span>{item.channel}</span>
                  <small>{item.account}</small>
                </div>
                <StatusChip status={item.status} />
                <div className="age-cell">
                  <strong>{item.age}</strong>
                  <small>
                    {item.attachmentCount > 0
                      ? `${item.attachmentCount} attachment`
                      : 'No attachment'}
                  </small>
                </div>
              </button>
            ))
          )}
        </div>
        {projection.source === 'hosted_durable' ? (
          <div className="inbox-pagination" aria-live="polite">
            <span>
              Showing {displayed.length.toLocaleString('en-US')} of{' '}
              {matchingCount.toLocaleString('en-US')} matching communications
            </span>
            {hostedPage.nextCursor === undefined ? null : (
              <button
                className="button button--secondary"
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? 'Loading…' : 'Load 100 more'}
              </button>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}

interface HostedThreadState {
  readonly kind: 'loading' | 'ready' | 'unavailable';
  readonly detail?: CommunicationDetailView;
  readonly thread?: ThreadContextView;
  readonly recommendation?: ActionRecommendation;
  readonly draft?: CitedDraftResult;
  readonly asana?: readonly WorkObjectFact[];
  readonly reason?: string;
}

type ThreadRouteKind = 'communication' | 'inbox' | 'thread';

function RoutedThreadPage({
  api,
  apiClient,
  projection,
  onProposalObserved,
  routeKind = 'inbox',
}: {
  readonly api: BrowserApi;
  readonly apiClient: ApiClient;
  readonly projection: ProductProjection;
  readonly onProposalObserved: (proposal: KnownProposalReference) => void;
  readonly routeKind?: ThreadRouteKind;
}) {
  const { messageRevisionId = '', threadId = '' } = useParams<{
    readonly messageRevisionId?: string;
    readonly threadId?: string;
  }>();
  const location = useLocation();
  const routeId = routeKind === 'communication' ? messageRevisionId : threadId;
  const parsedRouteId =
    routeKind === 'communication'
      ? messageRevisionIdSchema.safeParse(routeId)
      : threadIdSchema.safeParse(routeId);
  const safeRouteId =
    parsedRouteId.success && parsedRouteId.data === routeId
      ? parsedRouteId.data
      : undefined;
  const projectedCommunication =
    safeRouteId === undefined
      ? undefined
      : projection.communications.find((communication) => {
          if (routeKind === 'communication')
            return communication.messageRevisionId === safeRouteId;
          if (routeKind === 'thread')
            return communication.threadId === safeRouteId;
          return communication.id === safeRouteId;
        });
  const [resolvedCommunication, setResolvedCommunication] =
    useState<CommunicationFixture>();
  const [resolvingRoute, setResolvingRoute] = useState(false);

  useEffect(() => {
    let active = true;
    setResolvedCommunication(undefined);
    if (
      routeKind === 'inbox' ||
      projection.source !== 'hosted_durable' ||
      projectedCommunication !== undefined ||
      safeRouteId === undefined
    ) {
      setResolvingRoute(false);
      return () => {
        active = false;
      };
    }

    setResolvingRoute(true);
    const resolveCommunication =
      routeKind === 'communication'
        ? api
            .getCommunication(safeRouteId)
            .then((detail) => hostedCommunicationToView(detail))
        : api.getThread({ threadId: safeRouteId, limit: 20 }).then((thread) => {
            const latest =
              thread.communications.find(
                ({ messageRevisionId: revisionId }) =>
                  revisionId === thread.latestMessageRevisionId,
              ) ?? thread.communications.at(-1);
            return latest === undefined
              ? undefined
              : hostedCommunicationToView(latest);
          });
    void resolveCommunication.then(
      (communication) => {
        if (!active) return;
        setResolvedCommunication(communication);
        setResolvingRoute(false);
      },
      () => {
        if (!active) return;
        setResolvingRoute(false);
      },
    );
    return () => {
      active = false;
    };
  }, [api, projectedCommunication, projection.source, routeKind, safeRouteId]);

  if (projection.source === 'checking' || resolvingRoute) {
    return (
      <div className="page not-found" role="status">
        <RefreshCcw aria-hidden="true" size={34} />
        <p className="eyebrow">Checking hosted fixture</p>
        <h1>Loading the exact communication route.</h1>
        <p>No substitute thread is displayed while the typed API responds.</p>
      </div>
    );
  }
  const routedCommunication = (
    location.state as { readonly communication?: CommunicationFixture } | null
  )?.communication;
  const communication =
    projectedCommunication ??
    resolvedCommunication ??
    (routeKind === 'inbox' && routedCommunication?.id === safeRouteId
      ? routedCommunication
      : undefined);

  if (
    projection.source === 'local_fallback' &&
    safeRouteId === 'thread-q3-launch'
  ) {
    return <ThreadPage />;
  }

  return (
    <ProjectionThreadPage
      api={api}
      apiClient={apiClient}
      communication={communication}
      source={projection.source}
      onProposalObserved={onProposalObserved}
    />
  );
}

function AttachmentInboxAlias({
  api,
  projection,
}: {
  readonly api: BrowserApi;
  readonly projection: ProductProjection;
}) {
  const { attachmentId = '' } = useParams<{
    readonly attachmentId?: string;
  }>();
  const parsedAttachmentId = attachmentIdSchema.safeParse(attachmentId);
  if (!parsedAttachmentId.success || parsedAttachmentId.data !== attachmentId)
    return <NotFoundPage />;
  return <InboxPage api={api} projection={projection} />;
}

function ProjectionThreadPage({
  api,
  apiClient,
  communication,
  source,
  onProposalObserved,
}: {
  readonly api: BrowserApi;
  readonly apiClient: ApiClient;
  readonly communication?: CommunicationFixture;
  readonly source: ProjectionSource;
  readonly onProposalObserved: (proposal: KnownProposalReference) => void;
}) {
  const navigate = useNavigate();
  const [state, setState] = useState<HostedThreadState>({ kind: 'loading' });
  const [contextOutcome, setContextOutcome] = useState<string>();
  const [proposalOutcome, setProposalOutcome] = useState<string>();
  const [revisionComparison, setRevisionComparison] = useState<{
    readonly previous: string;
    readonly current: string;
  }>();
  const [approval, setApproval] = useState<DurableApprovalState>({
    kind: 'not_prepared',
  });
  const [draftSaving, setDraftSaving] = useState(false);
  const preparedDraftRevisionId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (communication === undefined) {
      setState({
        kind: 'unavailable',
        reason:
          'No communication matches this route in the current projection.',
      });
      return;
    }
    if (
      source !== 'hosted_durable' ||
      communication.threadId === undefined ||
      communication.messageRevisionId === undefined
    ) {
      setState({
        kind: 'unavailable',
        reason:
          'This local fallback record has summary evidence only; detailed thread, recommendation, and proposal projections are unavailable.',
      });
      return;
    }

    let active = true;
    const load = async () => {
      try {
        const [detail, thread, asana] = await Promise.all([
          api.getCommunication(communication.messageRevisionId!),
          api.getThread({ threadId: communication.threadId!, limit: 20 }),
          api.getRelatedAsanaWork(communication.messageRevisionId!, 10),
        ]);
        let recommendation: ActionRecommendation | undefined;
        let draft: CitedDraftResult | undefined;
        try {
          recommendation = await api.recommendAction(
            communication.messageRevisionId!,
            detail.revision,
          );
          if (
            recommendation.actionType !== 'ignore_system' &&
            recommendation.actionType !== 'no_action'
          ) {
            draft = await api.createDraft(
              recommendation.recommendationId,
              recommendation.revision,
            );
          }
        } catch {
          // Some read-only or already-answered fixture records intentionally
          // have no current recommendation or draft projection.
        }
        if (active) {
          setState({
            kind: 'ready',
            detail,
            thread,
            asana,
            ...(recommendation === undefined ? {} : { recommendation }),
            ...(draft === undefined ? {} : { draft }),
          });
        }
      } catch {
        if (active) {
          setState({
            kind: 'unavailable',
            reason:
              'The hosted typed API could not return this exact thread projection.',
          });
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [api, communication, source]);

  useEffect(() => {
    const draft = state.draft?.draft;
    if (
      draft === undefined ||
      draft.revision <= 1 ||
      communication?.threadId === undefined ||
      communication.messageRevisionId === undefined ||
      preparedDraftRevisionId.current === draft.draftRevisionId
    ) {
      return;
    }
    const proposalThreadId = communication.threadId;
    const proposalMessageRevisionId = communication.messageRevisionId;
    const proposalSubject = communication.subject;

    let active = true;
    preparedDraftRevisionId.current = draft.draftRevisionId;
    setApproval({ kind: 'preparing' });
    void apiClient.approvals.prepareDraft
      .mutate({
        draftRevisionId: draft.draftRevisionId,
        expectedDraftRevision: draft.revision,
      })
      .then(async (prepared) => {
        onProposalObserved({
          proposalId: prepared.proposalId,
          kind: 'draft_reply',
          threadId: proposalThreadId,
          messageRevisionId: proposalMessageRevisionId,
          subject: proposalSubject,
          ...(state.recommendation === undefined
            ? {}
            : { actionType: state.recommendation.actionType }),
        });
        const [status, execution] = await Promise.all([
          apiClient.approvals.status.query({
            proposalId: prepared.proposalId,
          }),
          apiClient.execution.status.query({
            proposalId: prepared.proposalId,
          }),
        ]);
        if (!active) return;
        if (
          status.status === 'approved' &&
          execution.status === 'effect_disabled' &&
          execution.receipt !== undefined
        ) {
          setApproval({
            kind: 'approved',
            proposalId: prepared.proposalId,
            updatedAt: status.updatedAt,
            receipt: execution.receipt,
          });
          return;
        }
        setApproval({
          kind: 'pending',
          proposalId: prepared.proposalId,
          updatedAt: status.updatedAt,
        });
      })
      .catch(() => {
        if (active) {
          setApproval({
            kind: 'error',
            message:
              'The durable approval handoff could not be loaded. Retry the revision when the hosted API is available.',
          });
        }
      });

    return () => {
      active = false;
    };
  }, [
    apiClient,
    communication,
    onProposalObserved,
    state.draft,
    state.recommendation,
  ]);

  const requestContext = () => {
    if (state.recommendation === undefined) return;
    void api
      .requestContext({
        recommendationId: state.recommendation.recommendationId,
        expectedRecommendationRevision: state.recommendation.revision,
        focusedQuestion: 'Which approved fact should determine the response?',
      })
      .then(
        (request) => {
          setContextOutcome(request.focusedQuestion);
        },
        () => {
          setContextOutcome(
            'Context proposal is unavailable from the hosted API.',
          );
        },
      );
  };

  const reviseDraft = () => {
    if (state.draft === undefined) return;
    const previous = state.draft.draft.body;
    setDraftSaving(true);
    void api
      .reviseDraft({
        draftRevisionId: state.draft.draft.draftRevisionId,
        expectedDraftRevision: state.draft.draft.revision,
        revisionInstruction: conciseRevisionInstruction,
      })
      .then(
        (draft) => {
          setState((current) => ({ ...current, draft }));
          setRevisionComparison({ previous, current: draft.draft.body });
          setApproval({ kind: 'not_prepared' });
          setDraftSaving(false);
        },
        () => {
          setProposalOutcome('Hosted draft revision could not be prepared.');
          setDraftSaving(false);
        },
      );
  };

  const approveDraft = () => {
    if (approval.kind !== 'pending') return;
    const pending = approval;
    setApproval({ ...pending, kind: 'approving' });
    void apiClient.approvals.approve
      .mutate({
        proposalId: pending.proposalId,
        expectedProposalUpdatedAt: pending.updatedAt,
      })
      .then((result) => {
        setApproval({
          kind: 'approved',
          proposalId: result.proposalId,
          updatedAt: result.updatedAt,
          receipt: result.receipt,
        });
      })
      .catch(async () => {
        try {
          const [status, execution] = await Promise.all([
            apiClient.approvals.status.query({
              proposalId: pending.proposalId,
            }),
            apiClient.execution.status.query({
              proposalId: pending.proposalId,
            }),
          ]);
          if (
            status.proposalId !== pending.proposalId ||
            execution.proposalId !== pending.proposalId
          ) {
            setApproval({
              kind: 'uncertain',
              proposalId: pending.proposalId,
              message:
                'The approval acknowledgement failed and the durable API returned a different proposal. Reload this exact thread before any retry. External effects remain disabled.',
            });
            return;
          }
          if (
            status.status === 'approved' &&
            execution.status === 'effect_disabled' &&
            execution.receipt !== undefined
          ) {
            setApproval({
              kind: 'approved',
              proposalId: pending.proposalId,
              updatedAt: status.updatedAt,
              receipt: execution.receipt,
              recoveredAfterAcknowledgementFailure: true,
            });
            return;
          }
          if (
            (status.status === 'prepared' ||
              status.status === 'pending_approval') &&
            execution.status !== 'effect_disabled' &&
            execution.receipt === undefined
          ) {
            setApproval({
              kind: 'pending',
              proposalId: pending.proposalId,
              updatedAt: status.updatedAt,
              notice:
                'The dispatch acknowledgement failed while durable status remains pending. No external effect or provider dispatch occurred.',
            });
            return;
          }
          setApproval({
            kind: 'uncertain',
            proposalId: pending.proposalId,
            message:
              'The approval acknowledgement failed and durable records are inconsistent. Reload this exact thread before any retry. External effects remain disabled.',
          });
        } catch {
          setApproval({
            kind: 'uncertain',
            proposalId: pending.proposalId,
            message:
              'The approval acknowledgement failed and durable status could not be reconciled. Reload this exact thread before any retry. External effects remain disabled.',
          });
        }
      });
  };

  const prepareAsana = () => {
    if (
      state.recommendation === undefined ||
      communication?.threadId === undefined ||
      communication.messageRevisionId === undefined
    )
      return;
    const proposalThreadId = communication.threadId;
    const proposalMessageRevisionId = communication.messageRevisionId;
    const proposalSubject = communication.subject;
    const actionType = state.recommendation.actionType;
    void api
      .prepareAsanaAction(
        state.recommendation.recommendationId,
        state.recommendation.revision,
      )
      .then(
        (proposal) => {
          onProposalObserved({
            proposalId: proposal.proposalId,
            kind: 'asana_action',
            threadId: proposalThreadId,
            messageRevisionId: proposalMessageRevisionId,
            subject: proposalSubject,
            actionType,
          });
          setProposalOutcome(
            `${proposal.status}: ${proposal.proposalId}. Direct effect available: no.`,
          );
        },
        () => {
          setProposalOutcome('Hosted Asana proposal could not be prepared.');
        },
      );
  };

  if (communication === undefined) {
    return (
      <div className="page not-found" data-testid="thread-unavailable">
        <Search aria-hidden="true" size={34} />
        <p className="eyebrow">Communication unavailable</p>
        <h1>This route is not present in the current fixture projection.</h1>
        <p>Return to the inbox; no substitute thread has been displayed.</p>
        <div>
          <Link className="button button--primary" to="/inbox">
            Open inbox
          </Link>
        </div>
      </div>
    );
  }

  const detail = state.detail;
  const thread = state.thread;

  return (
    <div className="page page--thread" data-testid="thread-detail">
      <div className="thread-breadcrumb">
        <button
          type="button"
          onClick={() => {
            void navigate('/inbox');
          }}
        >
          <Inbox aria-hidden="true" size={15} /> Inbox
        </button>
        <span>/</span>
        <span>{communication.sender}</span>
      </div>
      <PageHeader
        eyebrow={`${source === 'hosted_durable' ? 'Durable hosted seed' : 'Local fallback'} · ${communication.received} UTC`}
        title={communication.subject}
        description={`${communication.channel} · ${communication.account} · ${communication.sender}`}
        action={<StatusChip status={communication.status} />}
      />

      <div className="projection-thread-grid">
        <section
          className="surface projection-message"
          aria-label="Communication context"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Exact communication</p>
              <h2>{communication.sender}</h2>
            </div>
            <ModeChip mode="fixture" />
          </div>
          <p className="projection-body">
            {detail?.authoredText ?? communication.excerpt}
          </p>
          {detail?.attachments.map((attachment) => (
            <article
              className="attachment-card"
              data-testid={`attachment-${attachment.attachmentId}`}
              key={attachment.attachmentId}
            >
              <span className="icon-tile" aria-hidden="true">
                <Paperclip size={18} />
              </span>
              <div>
                <strong>{attachment.fileName}</strong>
                <span>
                  {attachment.mediaType} ·{' '}
                  {attachment.byteLength.toLocaleString('en-US')} bytes · scan{' '}
                  {attachment.malwareState}
                </span>
              </div>
            </article>
          ))}
          {state.kind === 'loading' ? (
            <p className="projection-notice" role="status">
              Loading typed hosted context…
            </p>
          ) : null}
          {state.kind === 'unavailable' ? (
            <p
              className="projection-notice projection-notice--warning"
              role="status"
            >
              {state.reason}
            </p>
          ) : null}
        </section>

        <section
          className="surface projection-history"
          aria-label="Thread history"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Thread context</p>
              <h2>
                {thread === undefined
                  ? 'Context unavailable'
                  : `${thread.communications.length} communication${thread.communications.length === 1 ? '' : 's'}`}
              </h2>
            </div>
            <MessageSquareText aria-hidden="true" size={19} />
          </div>
          {thread === undefined ? null : (
            <>
              <p className="participant-line">
                Participants: {thread.participantDisplayNames.join(', ')}
              </p>
              <ol className="projection-history-list">
                {thread.communications.map((item) => (
                  <li key={item.messageRevisionId}>
                    <strong>
                      {item.senderDisplayName ?? 'Unknown sender'}
                    </strong>
                    <p>{item.excerpt}</p>
                    <small>
                      {item.direction} · {item.status} ·{' '}
                      {new Date(item.sourceTimestamp).toLocaleString('en-GB', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: 'UTC',
                      })}{' '}
                      UTC
                    </small>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>

        {state.asana === undefined || state.asana.length === 0 ? null : (
          <section
            className="surface projection-history"
            aria-label="Related Asana work"
          >
            <div className="section-heading">
              <div>
                <p className="eyebrow">Read-only work context</p>
                <h2>Related Asana work</h2>
              </div>
              <ListChecks aria-hidden="true" size={19} />
            </div>
            <ol className="projection-history-list">
              {state.asana.map((fact) => (
                <li key={`${fact.kind}-${fact.providerObjectId}`}>
                  <strong>{fact.providerObjectId}</strong>
                  <p>{fact.kind.replaceAll('_', ' ')}</p>
                  <small>Fixture snapshot · external mutation disabled</small>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section
          className="surface projection-action"
          aria-label="Recommendation and proposals"
          data-testid={
            state.recommendation === undefined ? undefined : 'recommendation'
          }
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Typed propose projection</p>
              <h2>
                {state.recommendation?.actionType.replaceAll('_', ' ') ??
                  'No recommendation available'}
              </h2>
            </div>
            <Sparkles aria-hidden="true" size={19} />
          </div>
          {state.recommendation === undefined ? (
            <p className="projection-notice">
              This exact record has no supported current recommendation. No
              other communication is substituted.
            </p>
          ) : (
            <>
              <div className="confidence" data-testid="confidence">
                <span>Confidence</span>
                <strong>
                  {Math.round(state.recommendation.confidence * 100)}% ·{' '}
                  {state.recommendation.urgency}
                </strong>
                <div>
                  <span
                    style={{
                      width: `${state.recommendation.confidence * 100}%`,
                    }}
                  />
                </div>
              </div>
              <p className="projection-body">
                {state.recommendation.reasonSummary}
              </p>
              <div className="projection-citations">
                {state.recommendation.citations.map((citation) => (
                  <span
                    key={citation.citationId}
                    data-testid={`citation-${citation.citationId}`}
                  >
                    {citation.label}
                  </span>
                ))}
              </div>
              <button
                className="button button--secondary button--full"
                data-testid="context-request"
                type="button"
                onClick={requestContext}
              >
                <CircleHelp aria-hidden="true" size={17} /> Request additional
                context
              </button>
              {contextOutcome === undefined ? null : (
                <p className="projection-notice" role="status">
                  Focused context request: {contextOutcome} No notification or
                  external mutation occurred.
                </p>
              )}
            </>
          )}

          {state.draft === undefined ? null : (
            <div className="hosted-draft">
              <label htmlFor="hosted-draft-editor">
                Durable hosted draft revision {state.draft.draft.revision}
              </label>
              <textarea
                id="hosted-draft-editor"
                data-testid="draft-editor"
                rows={7}
                value={state.draft.draft.body}
                readOnly
                aria-describedby="bounded-revision-note"
              />
              <p className="approval-help" id="bounded-revision-note">
                This persisted body is read-only. Create a successor with the
                bounded concise instruction; free-form body edits are not
                accepted by this evaluator control.
              </p>
              <div className="draft-meta">
                <span>Style profile · concise · direct</span>
                <span>
                  {state.draft.factualCitationCount} factual citations
                </span>
                <span>Durable effect-disabled proposal</span>
              </div>
              <button
                className="button button--secondary button--full"
                type="button"
                disabled={draftSaving || state.draft.draft.revision >= 2}
                onClick={reviseDraft}
              >
                <PencilLine aria-hidden="true" size={16} />{' '}
                {draftSaving
                  ? 'Creating concise revision…'
                  : state.draft.draft.revision >= 2
                    ? 'Concise revision created'
                    : 'Create concise revision'}
              </button>
            </div>
          )}

          {revisionComparison === undefined ? null : (
            <div className="diff-card" data-testid="revision-diff">
              <strong>Durable immutable revision</strong>
              <p>
                <del>{revisionComparison.previous}</del>
              </p>
              <p>
                <ins>{revisionComparison.current}</ins>
              </p>
              <span>
                The hosted API applied “{conciseRevisionInstruction}” and
                persisted a successor body of{' '}
                {revisionComparison.current.length} characters, down from{' '}
                {revisionComparison.previous.length}.
              </span>
            </div>
          )}

          {state.recommendation === undefined ? null : (
            <button
              className="button button--tertiary button--full"
              type="button"
              onClick={prepareAsana}
            >
              <ListChecks aria-hidden="true" size={16} /> Prepare Asana
              follow-up
            </button>
          )}
          {proposalOutcome === undefined ? null : (
            <p
              className="projection-notice"
              data-testid="asana-status"
              role="status"
            >
              {proposalOutcome} The public API prepares proposals only.
            </p>
          )}

          <div className="public-approval-boundary">
            <LockKeyhole aria-hidden="true" size={17} />
            <div>
              <strong>Server-authorized durable approval.</strong>
              <p>
                Approval is bound to the server-selected evaluator actor and
                exact persisted revision. Provider dispatch remains disabled.
              </p>
            </div>
          </div>
          {approval.kind === 'pending' && approval.notice !== undefined ? (
            <p
              className="projection-notice projection-notice--warning"
              data-testid="approval-reconciliation-pending"
              role="status"
            >
              {approval.notice}
            </p>
          ) : null}
          {approval.kind === 'approved' ? (
            <>
              {approval.recoveredAfterAcknowledgementFailure === true ? (
                <p
                  className="projection-notice"
                  data-testid="approval-recovered"
                  role="status"
                >
                  The approval acknowledgement failed, but a durable approved
                  status and effect-disabled receipt were recovered. No external
                  effect occurred.
                </p>
              ) : null}
              <ExecutionReceipt
                proposalId={approval.proposalId}
                receipt={approval.receipt}
              />
            </>
          ) : approval.kind === 'uncertain' ? (
            <p
              className="projection-notice projection-notice--warning"
              data-testid="approval-reconciliation-uncertain"
              role="alert"
            >
              {approval.message}
            </p>
          ) : approval.kind === 'error' ? (
            <p
              className="projection-notice projection-notice--warning"
              role="alert"
            >
              {approval.message}
            </p>
          ) : (
            <button
              className="button button--primary button--full"
              data-testid="approve-action"
              type="button"
              disabled={approval.kind !== 'pending'}
              onClick={approveDraft}
            >
              <UserRoundCheck aria-hidden="true" size={17} />{' '}
              {approval.kind === 'preparing'
                ? 'Preparing durable approval…'
                : approval.kind === 'approving'
                  ? 'Persisting approval…'
                  : 'Approve exact durable revision'}
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

function ThreadPage() {
  const [draft, setDraft] = useState(initialDraft);
  const [isRevised, setIsRevised] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const navigate = useNavigate();

  const revise = () => {
    setDraft(revisedDraft);
    setIsRevised(true);
  };

  return (
    <div className="page page--thread" data-testid="thread-detail">
      <div className="thread-breadcrumb">
        <button
          type="button"
          onClick={() => {
            void navigate('/inbox');
          }}
        >
          <Inbox aria-hidden="true" size={15} /> Inbox
        </button>
        <span>/</span>
        <span>Taylor Reed</span>
      </div>
      <PageHeader
        eyebrow="Overdue · 6m 12s since trusted ingress"
        title="Q3 launch risk and customer note"
        description="Gmail-shaped fixture thread · Northstar Executive · received 09:36 UTC"
        action={<StatusChip status="overdue" />}
      />

      <div className="thread-layout">
        <section
          className="thread-column"
          aria-label="Conversation and attachments"
        >
          <article className="surface message-card">
            <header className="message-header">
              <span className="avatar avatar--large" aria-hidden="true">
                TR
              </span>
              <div>
                <strong>Taylor Reed</strong>
                <span>VP, Customer Success · taylor@customer.example</span>
              </div>
              <time dateTime="2026-07-18T09:36:00Z">09:36 UTC</time>
            </header>
            <div className="message-body">
              <p>
                Alex — the enterprise pilot is still on track, but the security
                review now overlaps the launch window.
              </p>
              <p>
                Security expects the red-team summary by end of day. Customer
                Success needs a go/no-go by 17:00 UTC so we can prepare the
                customer note. Should we hold 26 July, or signal a
                one-business-day adjustment now?
              </p>
              <p>
                I attached the current risk register. The owner for the customer
                note is still unclear.
              </p>
              <p>— Taylor</p>
            </div>
            <AttachmentCard />
          </article>

          <section
            className="surface thread-history"
            aria-labelledby="history-heading"
          >
            <div className="section-heading">
              <div>
                <p className="eyebrow">Conversation history</p>
                <h2 id="history-heading">3 related messages</h2>
              </div>
              <ModeChip mode="fixture" />
            </div>
            <ol>
              <li>
                <span className="history-dot" />
                <div>
                  <strong>You · 26 Jun</strong>
                  <p>
                    Keep updates concise: owner, checkpoint, and the decision
                    needed.
                  </p>
                  <small>Gmail · answered in 2m 08s</small>
                </div>
              </li>
              <li>
                <span className="history-dot" />
                <div>
                  <strong>Taylor Reed · 11 Jul</strong>
                  <p>
                    Security review starts Monday; no external date change
                    unless the recovery plan slips.
                  </p>
                  <small>Gmail fixture · linked to synthetic DEMO-4821</small>
                </div>
              </li>
              <li>
                <span className="history-dot history-dot--current" />
                <div>
                  <strong>Taylor Reed · Today</strong>
                  <p>Go/no-go required by 17:00 UTC.</p>
                  <small>Current · overdue</small>
                </div>
              </li>
            </ol>
          </section>
        </section>

        <section className="evidence-column" aria-label="Retrieved evidence">
          <div className="surface evidence-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Grounding</p>
                <h2>Evidence & context</h2>
              </div>
              <BadgeCheck aria-hidden="true" size={20} />
            </div>
            <div className="model-receipt">
              <Bot aria-hidden="true" size={17} />
              <div>
                <strong>Deterministic assessment recommendation</strong>
                <span>No live model call · fixture receipt rag-fx-2048</span>
              </div>
            </div>
            <div className="citation-list">
              {citations.map((citation, index) => (
                <article
                  className="citation"
                  key={citation.id}
                  data-testid={`citation-${citation.id}`}
                >
                  <header>
                    <span>{index + 1}</span>
                    <strong>{citation.label}</strong>
                  </header>
                  <h3>{citation.title}</h3>
                  <p>{citation.excerpt}</p>
                  <small>{citation.source}</small>
                </article>
              ))}
            </div>
            <section className="asana-context" aria-label="Related Asana work">
              <div>
                <span className="icon-tile">
                  <ListChecks aria-hidden="true" size={18} />
                </span>
                <div>
                  <strong>DEMO-4821 · Synthetic pilot review fixture</strong>
                  <span>In review · due today · owner Priya Shah</span>
                </div>
              </div>
              <InlineLink to="/evidence#retrieval">
                Open retrieval evidence
              </InlineLink>
            </section>
          </div>
        </section>

        <section
          className="action-column"
          aria-label="Recommendation and approval"
        >
          <article
            className="surface recommendation-card"
            data-testid="recommendation"
          >
            <div className="section-heading">
              <div>
                <p className="eyebrow">Recommended action</p>
                <h2>Reply and prepare follow-up</h2>
              </div>
              <Sparkles aria-hidden="true" size={20} />
            </div>
            <div className="confidence" data-testid="confidence">
              <span>Confidence</span>
              <strong>88% · High</strong>
              <div>
                <span style={{ width: '88%' }} />
              </div>
            </div>
            <p>
              Hold the launch date internally, set a 16:00 evidence deadline,
              and make the 17:00 checkpoint the explicit go/no-go. Prepare—but
              do not send—a customer adjustment note.
            </p>
            <ul className="reason-list">
              <li>
                <Check size={14} />
                Matches the documented launch communication rule.
              </li>
              <li>
                <Check size={14} />
                Names the existing Asana owner and decision task.
              </li>
              <li>
                <Check size={14} />
                Mirrors Alex’s concise, action-first response style.
              </li>
            </ul>
            <button
              className="button button--secondary button--full"
              data-testid="context-request"
              type="button"
              aria-expanded={contextOpen}
              onClick={() => setContextOpen((current) => !current)}
            >
              <CircleHelp aria-hidden="true" size={17} /> Request additional
              context
            </button>
            {contextOpen ? (
              <div className="context-request" role="status">
                <strong>Focused context request prepared</strong>
                <p>
                  Who owns the customer-facing note if the 17:00 checkpoint
                  slips?
                </p>
                <span>Local fixture state only · no notification sent</span>
              </div>
            ) : null}
          </article>

          <article className="surface draft-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Style-matched draft</p>
                <h2>Revision {isRevised ? '2' : '1'}</h2>
              </div>
              <span className="style-chip">Direct · concise · no hedging</span>
            </div>
            <label htmlFor="draft-editor">Reply body</label>
            <textarea
              id="draft-editor"
              data-testid="draft-editor"
              value={draft}
              readOnly
              aria-describedby="local-bounded-revision-note"
              rows={12}
            />
            <p className="approval-help" id="local-bounded-revision-note">
              Read-only fallback body. The bounded control demonstrates “
              {conciseRevisionInstruction}” without granting durable approval
              authority.
            </p>
            <div className="draft-meta">
              <span>Style profile v12</span>
              <span>3 factual citations</span>
              <span>Renderer: email-text v1</span>
            </div>
            <button
              className="button button--secondary button--full"
              type="button"
              disabled={isRevised}
              onClick={revise}
            >
              <PencilLine aria-hidden="true" size={16} />{' '}
              {isRevised
                ? 'Concise revision created'
                : 'Create concise revision'}
            </button>
          </article>

          {!isRevised ? null : (
            <article className="surface diff-card" data-testid="revision-diff">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Immutable revision</p>
                  <h2>Revision 1 → 2</h2>
                </div>
                <RefreshCcw aria-hidden="true" size={18} />
              </div>
              <p>
                <del>Keep the 26 July launch target internal for now.</del>
              </p>
              <p>
                <ins>Hold the 26 July launch target internally for now.</ins>
              </p>
              <p>
                <del>I’ll review both at the 17:00 checkpoint.</del>
              </p>
              <p>
                <ins>I’ll make the go/no-go call at 17:00 UTC.</ins>
              </p>
              <div className="invalidation-note">
                <LockKeyhole aria-hidden="true" size={15} /> Revision 1 approval
                is invalid. Only revision 2 can be approved.
              </div>
            </article>
          )}

          <article className="surface approval-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Approval ceremony</p>
                <h2>Review exact action plan</h2>
              </div>
              <ShieldCheck aria-hidden="true" size={20} />
            </div>
            <dl className="approval-plan">
              <div>
                <dt>Channel / account</dt>
                <dd>Gmail fixture · Northstar Executive</dd>
              </div>
              <div>
                <dt>Recipient</dt>
                <dd>Taylor Reed · controlled fixture identity</dd>
              </div>
              <div>
                <dt>Message effect</dt>
                <dd>Effect-disabled sink only</dd>
              </div>
              <div>
                <dt>Asana effect</dt>
                <dd>Prepare comment for synthetic DEMO-4821 · disabled</dd>
              </div>
              <div>
                <dt>Revision hash</dt>
                <dd className="mono">8e41…a29c · revision 2</dd>
              </div>
            </dl>
            <button
              className="button button--primary button--full"
              data-testid="approve-action"
              type="button"
              disabled
            >
              <UserRoundCheck aria-hidden="true" size={17} /> Hosted durable
              approval required
            </button>
            <p className="approval-help">
              {isRevised
                ? 'This local fallback revision is not persisted and cannot be approved.'
                : 'Create revision 2, then use the hosted durable evaluator to approve it.'}
            </p>
          </article>
        </section>
      </div>
    </div>
  );
}

function ExecutionReceipt({
  proposalId,
  receipt,
}: {
  readonly proposalId: string;
  readonly receipt: DurableApprovalReceipt;
}) {
  return (
    <article className="surface receipt-card" data-testid="execution-receipt">
      <div className="receipt-status">
        <CheckCircle2 aria-hidden="true" size={21} />
        <div>
          <strong>Execution completed safely</strong>
          <span>
            Durable effect-disabled receipt · no provider or Asana request
            occurred
          </span>
        </div>
      </div>
      <dl>
        <div>
          <dt>Outcome</dt>
          <dd>effect_disabled</dd>
        </div>
        <div>
          <dt>Operation</dt>
          <dd className="mono">{receipt.operationId}</dd>
        </div>
        <div>
          <dt>Proposal</dt>
          <dd className="mono">{proposalId}</dd>
        </div>
        <div>
          <dt>Idempotency</dt>
          <dd className="mono">{receipt.stableIdempotencyKey}</dd>
        </div>
        <div>
          <dt>External network</dt>
          <dd>Denied by fixture policy</dd>
        </div>
      </dl>
      <section className="asana-receipt" data-testid="asana-status">
        <ListChecks aria-hidden="true" size={18} />
        <div>
          <strong>Asana follow-up prepared</strong>
          <span>
            Synthetic DEMO-4821 plan retained · no external task exists
          </span>
        </div>
        <ModeChip mode="fixture" />
      </section>
      <ol className="mini-timeline" data-testid="audit-timeline">
        <li>
          <span />
          <div>
            <strong>
              {new Date(receipt.observedAt).toLocaleTimeString('en-GB')}
            </strong>{' '}
            Approval bound to revision hash
          </div>
        </li>
        <li>
          <span />
          <div>
            <strong>{receipt.operationId}</strong> Outbox operation persisted
            once
          </div>
        </li>
        <li>
          <span />
          <div>
            <strong>{receipt.artifactHash.slice(0, 12)}…</strong> Preflight
            confirmed effect switch off
          </div>
        </li>
        <li>
          <span />
          <div>
            <strong>Durable reload</strong> Receipt persisted; no external call
          </div>
        </li>
      </ol>
    </article>
  );
}

function isProposalNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    readonly message?: unknown;
    readonly data?: { readonly code?: unknown };
  };
  return (
    candidate.data?.code === 'NOT_FOUND' ||
    (typeof candidate.message === 'string' &&
      /proposal (?:was )?not found/i.test(candidate.message))
  );
}

function RecommendedActionsPage({
  api,
  projection,
}: {
  readonly api: BrowserApi;
  readonly projection: ProductProjection;
}) {
  const [state, setState] = useState<RecommendedActionsState>({
    kind: 'loading',
  });

  useEffect(() => {
    if (projection.source !== 'hosted_durable') {
      setState({
        kind: 'unavailable',
        message:
          'Recommended actions require the authenticated hosted API. The local fallback does not fabricate recommendation records.',
      });
      return;
    }

    let active = true;
    setState({ kind: 'loading' });
    const load = async () => {
      try {
        const [pending, overdue] = await Promise.all([
          listAllCommunicationsByStatus(api, 'pending'),
          listAllCommunicationsByStatus(api, 'overdue'),
        ]);
        const latestByThread = new Map<string, CommunicationSummaryView>();
        for (const communication of [...pending, ...overdue]) {
          if (communication.direction !== 'inbound') continue;
          const current = latestByThread.get(communication.threadId);
          if (
            current === undefined ||
            communication.sourceTimestamp > current.sourceTimestamp
          ) {
            latestByThread.set(communication.threadId, communication);
          }
        }
        const communicationsToInspect = [...latestByThread.values()].sort(
          (left, right) =>
            right.sourceTimestamp.localeCompare(left.sourceTimestamp),
        );
        const outcomes = await mapWithConcurrency(
          communicationsToInspect,
          6,
          async (communication) => {
            try {
              const recommendation = await api.recommendAction(
                communication.messageRevisionId,
                communication.revision,
              );
              if (
                recommendation.sourceMessageRevisionId !==
                communication.messageRevisionId
              ) {
                return { kind: 'unavailable' } as const;
              }
              return {
                kind: 'ready',
                item: { communication, recommendation },
              } as const;
            } catch {
              return { kind: 'unavailable' } as const;
            }
          },
        );
        if (!active) return;
        setState({
          kind: 'ready',
          items: outcomes.flatMap((outcome) =>
            outcome.kind === 'ready' ? [outcome.item] : [],
          ),
          inspectedCount: communicationsToInspect.length,
          unavailableCount: outcomes.filter(
            (outcome) => outcome.kind === 'unavailable',
          ).length,
        });
      } catch {
        if (!active) return;
        setState({
          kind: 'unavailable',
          message:
            'The hosted communication queue could not be enumerated safely. No recommendation, draft, proposal, or external effect is shown as successful.',
        });
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [api, projection.source]);

  return (
    <div className="page" data-testid="recommended-actions-page">
      <PageHeader
        eyebrow="Server recommendations · read first"
        title="Recommended actions"
        description="Every row below comes from the typed hosted communication and recommendation APIs. This view creates no draft, proposal, approval, or provider effect."
        action={
          <Link className="button button--secondary" to="/approvals">
            <ClipboardCheck aria-hidden="true" size={17} /> Open approvals
          </Link>
        }
      />
      <section className="surface approval-queue" aria-live="polite">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Aggregate actionable queue</p>
            <h2>Current inbound pending and overdue threads</h2>
          </div>
          <Sparkles aria-hidden="true" size={20} />
        </div>
        <p className="projection-notice">
          Deterministic non-PII evaluator records · fixture/effect-disabled
          runtime · recommendation text is displayed only when returned for the
          exact server message revision.
        </p>
        {state.kind === 'loading' ? (
          <div className="empty-state" role="status">
            <RefreshCcw
              className="auth-state-icon--spin"
              aria-hidden="true"
              size={24}
            />
            <h3>Reading current server recommendations</h3>
            <p>
              Enumerating the bounded actionable queue without preparing
              effects.
            </p>
          </div>
        ) : state.kind === 'unavailable' ? (
          <div className="empty-state" role="alert">
            <CircleHelp aria-hidden="true" size={24} />
            <h3>Recommendations are unavailable</h3>
            <p>{state.message}</p>
          </div>
        ) : state.items.length === 0 ? (
          <div className="empty-state" role="status">
            <CheckCircle2 aria-hidden="true" size={24} />
            <h3>No current recommendation responses</h3>
            <p>
              The server returned no displayable recommendation for the{' '}
              {state.inspectedCount} actionable threads inspected. No fallback
              actions were invented.
            </p>
          </div>
        ) : (
          <>
            <p className="projection-notice" data-testid="recommendation-scope">
              Showing {state.items.length} server recommendations from{' '}
              {state.inspectedCount} unique actionable threads.
              {state.unavailableCount === 0
                ? ' Every inspected thread returned an exact recommendation.'
                : ` ${state.unavailableCount} threads did not return a verifiable current recommendation and are omitted.`}
            </p>
            <div className="queue-list">
              {state.items.map(({ communication, recommendation }) => (
                <Link
                  className="queue-row"
                  data-testid="recommended-action-row"
                  key={recommendation.recommendationId}
                  to={`/threads/${communication.threadId}`}
                  state={{
                    communication: hostedCommunicationToView(communication),
                  }}
                >
                  <QueueIcon status={communication.status} />
                  <div className="queue-content">
                    <div>
                      <strong>
                        {communication.subject ??
                          'Communication without subject'}
                      </strong>
                      <span>
                        {Math.round(recommendation.confidence * 100)}%
                      </span>
                    </div>
                    <p>{recommendation.reasonSummary}</p>
                    <small>
                      {formatActionType(recommendation.actionType)} ·{' '}
                      {recommendation.urgency} urgency ·{' '}
                      {recommendation.citations.length} citations ·{' '}
                      {recommendation.missingFacts.length} missing facts ·{' '}
                      {formatChannel(communication.channel)} fixture
                    </small>
                  </div>
                  <StatusChip status={communication.status} />
                </Link>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function ApprovalStatusPage({ apiClient }: { readonly apiClient: ApiClient }) {
  const { proposalId: routeProposalId } = useParams<{
    proposalId: string;
  }>();
  const [state, setState] = useState<ApprovalRouteState>({ kind: 'loading' });

  useEffect(() => {
    const parsedProposalId = proposalIdSchema.safeParse(routeProposalId);
    if (
      !parsedProposalId.success ||
      parsedProposalId.data !== routeProposalId
    ) {
      setState({ kind: 'not_found' });
      return;
    }

    let active = true;
    setState({ kind: 'loading' });
    void Promise.all([
      apiClient.approvals.status.query({
        proposalId: parsedProposalId.data,
      }),
      apiClient.execution.status.query({
        proposalId: parsedProposalId.data,
      }),
    ])
      .then(([approval, execution]) => {
        if (!active) return;
        if (
          approval.proposalId !== parsedProposalId.data ||
          execution.proposalId !== parsedProposalId.data
        ) {
          setState({
            kind: 'error',
            message:
              'The durable API returned status for a different proposal. No action was taken.',
          });
          return;
        }
        if (
          approval.status === 'approved' &&
          (execution.status !== 'effect_disabled' ||
            execution.receipt === undefined)
        ) {
          setState({
            kind: 'error',
            message:
              'Approval is recorded, but its effect-disabled durable receipt is unavailable.',
          });
          return;
        }
        if (
          approval.status !== 'approved' &&
          (execution.status === 'effect_disabled' ||
            execution.receipt !== undefined)
        ) {
          setState({
            kind: 'error',
            message:
              'The durable approval and execution records disagree. No action was taken.',
          });
          return;
        }
        setState({
          kind: 'ready',
          proposalId: approval.proposalId,
          approvalStatus: approval.status,
          executionStatus: execution.status,
          updatedAt: approval.updatedAt,
          ...(execution.receipt === undefined
            ? {}
            : { receipt: execution.receipt }),
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState(
          isProposalNotFound(error)
            ? { kind: 'not_found' }
            : {
                kind: 'error',
                message:
                  'The durable proposal status could not be loaded. No action was taken.',
              },
        );
      });

    return () => {
      active = false;
    };
  }, [apiClient, routeProposalId]);

  if (state.kind === 'loading') {
    return (
      <div className="page">
        <PageHeader
          eyebrow="Durable approval"
          title="Loading proposal status"
          description="Reading the bounded approval and execution records. This route cannot approve or dispatch anything."
        />
        <section
          className="surface empty-state"
          role="status"
          data-testid="approval-route-loading"
        >
          <RefreshCcw aria-hidden="true" size={24} />
          <h2>Checking durable records</h2>
          <p>External effects remain disabled while status is read.</p>
        </section>
      </div>
    );
  }

  if (state.kind === 'not_found') {
    return (
      <div className="page not-found" data-testid="approval-route-not-found">
        <Search aria-hidden="true" size={34} />
        <p className="eyebrow">Proposal not found</p>
        <h1>This durable approval record does not exist.</h1>
        <p>No approval or external action was created by opening this route.</p>
        <Link className="button button--primary" to="/approvals">
          Open approvals
        </Link>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="page">
        <PageHeader
          eyebrow="Durable approval"
          title="Proposal status unavailable"
          description="The read-only status request failed safely. No approval or external action was attempted."
        />
        <section
          className="surface error-state"
          role="alert"
          data-testid="approval-route-error"
        >
          <CircleHelp aria-hidden="true" size={24} />
          <h2>Status could not be verified</h2>
          <p>{state.message}</p>
          <Link className="button button--secondary" to="/approvals">
            Open approvals
          </Link>
        </section>
      </div>
    );
  }

  const pending = state.approvalStatus !== 'approved';
  return (
    <div className="page" data-testid="approval-route-status">
      <PageHeader
        eyebrow="Durable approval · read only"
        title={pending ? 'Approval is pending' : 'Approval completed safely'}
        description="This proposal-specific view reads durable approval and execution status only. It cannot approve, send, or dispatch."
        action={
          <Link className="button button--secondary" to="/approvals">
            Back to approvals
          </Link>
        }
      />
      <section className="surface approval-focus">
        <p className="eyebrow">Exact proposal</p>
        <h2 className="mono">{state.proposalId}</h2>
        <dl className="approval-plan">
          <div>
            <dt>Approval state</dt>
            <dd>{state.approvalStatus}</dd>
          </div>
          <div>
            <dt>Execution state</dt>
            <dd>{state.executionStatus}</dd>
          </div>
          <div>
            <dt>External effects</dt>
            <dd>Disabled · no dispatch authority</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{new Date(state.updatedAt).toLocaleString('en-GB')}</dd>
          </div>
        </dl>
      </section>
      {state.receipt === undefined ? (
        <section
          className="surface empty-state"
          role="status"
          data-testid="approval-route-pending"
        >
          <Clock3 aria-hidden="true" size={24} />
          <h2>No execution receipt yet</h2>
          <p>
            The proposal remains {state.approvalStatus}. No provider request or
            external effect has occurred.
          </p>
        </section>
      ) : (
        <ExecutionReceipt
          proposalId={state.proposalId}
          receipt={state.receipt}
        />
      )}
    </div>
  );
}

function ApprovalsPage({
  api,
  projection,
  knownProposals,
}: {
  readonly api: BrowserApi;
  readonly projection: ProductProjection;
  readonly knownProposals: readonly KnownProposalReference[];
}) {
  const pendingApprovalCount = projection.metrics?.pendingApprovalCount ?? 0;
  const pendingApprovalLabel =
    projection.metrics === undefined
      ? 'Pending aggregate unavailable'
      : `${pendingApprovalCount} pending server-wide`;
  const [state, setState] = useState<ProposalQueueState>({ kind: 'loading' });

  useEffect(() => {
    if (knownProposals.length === 0) {
      setState({ kind: 'ready', items: [], unavailableCount: 0 });
      return;
    }

    let active = true;
    setState({ kind: 'loading' });
    void Promise.all(
      knownProposals.map(async (reference) => {
        try {
          const [approval, execution] = await Promise.all([
            api.getApprovalStatus(reference.proposalId),
            api.getExecutionStatus(reference.proposalId),
          ]);
          if (
            approval.proposalId !== reference.proposalId ||
            execution.proposalId !== reference.proposalId ||
            (approval.status === 'approved' &&
              (execution.status !== 'effect_disabled' ||
                execution.receipt === undefined)) ||
            (approval.status !== 'approved' &&
              (execution.status === 'effect_disabled' ||
                execution.receipt !== undefined))
          ) {
            return undefined;
          }
          return { reference, approval, execution };
        } catch {
          return undefined;
        }
      }),
    ).then((results) => {
      if (!active) return;
      const items = results
        .filter((result): result is VerifiedProposal => result !== undefined)
        .sort((left, right) =>
          right.approval.updatedAt.localeCompare(left.approval.updatedAt),
        );
      setState({
        kind: 'ready',
        items,
        unavailableCount: results.length - items.length,
      });
    });

    return () => {
      active = false;
    };
  }, [api, knownProposals]);

  return (
    <div className="page" data-testid="approvals-page">
      <PageHeader
        eyebrow="Human control plane"
        title="Approvals"
        description="This queue contains only proposal IDs returned by a real preparation API call since Chief was loaded in this tab, and rechecks their current server status before display. Provider dispatch remains disabled."
        action={
          <Link className="button button--secondary" to="/recommended">
            <Sparkles aria-hidden="true" size={17} /> Review recommendations
          </Link>
        }
      />
      <div className="approval-page-grid">
        <section className="surface approval-queue">
          <div className="section-heading">
            <div>
              <p className="eyebrow" data-testid="approval-pending-count">
                {pendingApprovalLabel}
              </p>
              <h2>Verified proposals known in this tab</h2>
            </div>
            <Filter aria-hidden="true" size={18} />
          </div>
          {state.kind === 'loading' ? (
            <div className="empty-state" role="status">
              <RefreshCcw
                className="auth-state-icon--spin"
                aria-hidden="true"
                size={24}
              />
              <h3>Checking durable proposal records</h3>
              <p>No approval or provider request is made while status loads.</p>
            </div>
          ) : state.items.length === 0 ? (
            <div className="empty-state" role="status">
              <ClipboardCheck aria-hidden="true" size={24} />
              <h3>No verified proposal is known in this tab</h3>
              <p>
                Open a recommended thread and prepare its exact revised draft.
                The resulting server proposal will appear here; no demonstration
                card is substituted.
              </p>
              <Link className="button button--secondary" to="/recommended">
                Open recommended actions
              </Link>
            </div>
          ) : (
            state.items.map(({ reference, approval, execution }) => (
              <Link
                className="approval-row"
                data-testid="approval-queue-row"
                key={reference.proposalId}
                to={`/approvals/${reference.proposalId}`}
              >
                <span className="queue-icon">
                  {reference.kind === 'draft_reply' ? (
                    <Send aria-hidden="true" size={16} />
                  ) : (
                    <ListChecks aria-hidden="true" size={16} />
                  )}
                </span>
                <div>
                  <strong>{reference.subject}</strong>
                  <p className="mono">{reference.proposalId}</p>
                  <small>
                    {reference.kind === 'draft_reply'
                      ? 'Exact draft revision'
                      : 'Asana action preparation'}
                    {reference.actionType === undefined
                      ? ''
                      : ` · ${formatActionType(reference.actionType)}`}{' '}
                    · {execution.status} · external effects disabled
                  </small>
                </div>
                <span className="period-chip">
                  {approval.status.replaceAll('_', ' ')}
                </span>
              </Link>
            ))
          )}
          {state.kind === 'ready' && state.unavailableCount > 0 ? (
            <p className="projection-notice" role="status">
              {state.unavailableCount} known proposal IDs could not be verified
              against consistent approval and execution records, so they are
              omitted.
            </p>
          ) : null}
        </section>
        <section className="surface approval-focus">
          <p className="eyebrow">Enumeration boundary</p>
          <h2>Count and identities are different API facts</h2>
          <p className="approval-summary">
            The dashboard reports the aggregate pending count, but the current
            product API has no list-proposals endpoint. Chief therefore shows
            only exact IDs observed from preparation calls in this browser tab
            since Chief loaded and verifies each one through approval and
            execution status APIs. It never invents rows to make the count look
            complete.
          </p>
          <dl className="approval-plan">
            <div>
              <dt>Server aggregate</dt>
              <dd>
                {projection.metrics === undefined
                  ? 'Unavailable outside the hosted projection'
                  : `${pendingApprovalCount} pending approvals`}
              </dd>
            </div>
            <div>
              <dt>Known exact IDs</dt>
              <dd>{knownProposals.length} since Chief loaded in this tab</dd>
            </div>
            <div>
              <dt>Displayed rows</dt>
              <dd>
                {state.kind === 'loading' ? 'Checking' : state.items.length}
              </dd>
            </div>
            <div>
              <dt>External effects</dt>
              <dd>Disabled · no provider dispatch authority</dd>
            </div>
            <div>
              <dt>Data mode</dt>
              <dd>Deterministic non-PII fixture records</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}

function ConnectionsPage({
  apiState,
  projection,
}: {
  readonly apiState: ApiState;
  readonly projection: ProductProjection;
}) {
  const modeCount = (mode: ConnectorFixture['mode']) =>
    projection.connectors.filter((connector) => connector.mode === mode).length;
  const isHosted = projection.source === 'hosted_durable';
  const hostedSeedCounts = isHosted
    ? {
        sourceOwned: projection.connectors.length,
        recorded: modeCount('recorded'),
        blocked: modeCount('blocked'),
      }
    : { sourceOwned: 1, recorded: 0, blocked: 0 };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Onboarding & capability truth"
        title="Connections"
        description="Inspect the seven deterministic hosted communication connectors and their exact effect-disabled capabilities."
        action={
          <Link className="button button--secondary" to="/evidence#connections">
            <Plus aria-hidden="true" size={17} /> Connection guide
          </Link>
        }
      />
      <section
        className="surface connection-seed-summary"
        data-testid="hosted-connector-seed-summary"
      >
        <strong>Hosted evaluator seed</strong>
        <p>
          Seven account-scoped connector cards back the hosted multichannel
          corpus: six fixture-mode cards and one manual/recorded LinkedIn
          archive card. Every card is synthetic, deterministic, and
          effect-disabled.
        </p>
        <dl>
          <div>
            <dt>Source-owned cards</dt>
            <dd data-testid="hosted-seed-fixture-count">
              {hostedSeedCounts.sourceOwned} hosted connector cards
            </dd>
          </div>
          <div>
            <dt>Recorded</dt>
            <dd data-testid="hosted-seed-recorded-count">
              {hostedSeedCounts.recorded} hosted evidence{' '}
              {hostedSeedCounts.recorded === 1 ? 'card' : 'cards'}
            </dd>
          </div>
          <div>
            <dt>Blocked</dt>
            <dd data-testid="hosted-seed-blocked-count">
              {hostedSeedCounts.blocked} hosted connector cards
            </dd>
          </div>
        </dl>
        {!isHosted ? (
          <small>
            The additional cards below are local fallback demonstrations, not
            hosted seed evidence.
          </small>
        ) : null}
      </section>
      <section className="mode-legend" aria-label="Capability mode legend">
        <article>
          <ModeChip mode="live" testId="capability-mode-legend-live" />
          <strong data-testid="connection-count-live">
            {modeCount('live')} {isHosted ? 'hosted cards' : 'in this session'}
          </strong>
          <span>Current provider connection with direct runtime proof</span>
        </article>
        <article>
          <ModeChip mode="recorded" testId="capability-mode-legend-recorded" />
          <strong data-testid="connection-count-recorded">
            {modeCount('recorded')}{' '}
            {isHosted ? 'hosted evidence cards' : 'evidence sets'}
          </strong>
          <span>Prior provider-shaped receipt; no current call</span>
        </article>
        <article>
          <ModeChip mode="fixture" testId="capability-mode-legend-fixture" />
          <strong data-testid="connection-count-fixture">
            {modeCount('fixture')}{' '}
            {isHosted
              ? 'hosted fixture connector cards'
              : 'deterministic adapters'}
          </strong>
          <span>Local seeded records with external effects disabled</span>
        </article>
        <article>
          <ModeChip mode="blocked" testId="capability-mode-legend-blocked" />
          <strong data-testid="connection-count-blocked">
            {modeCount('blocked')}{' '}
            {isHosted ? 'hosted blocked cards' : 'authorization gates'}
          </strong>
          <span>Unavailable until provider access is proven</span>
        </article>
      </section>
      <section
        className="onboarding-strip"
        aria-label="Connector onboarding steps"
      >
        <div className="onboarding-step onboarding-step--complete">
          <span>
            <Check size={16} />
          </span>
          <div>
            <strong>1. Review hosted scope</strong>
            <small>Six fixture · one recorded</small>
          </div>
        </div>
        <div className="onboarding-line" />
        <div className="onboarding-step onboarding-step--current">
          <span>2</span>
          <div>
            <strong>Inspect the connector card</strong>
            <small>Capabilities are independently labeled</small>
          </div>
        </div>
        <div className="onboarding-line" />
        <div className="onboarding-step">
          <span>3</span>
          <div>
            <strong>Review mode definitions</strong>
            <small>Zero-count modes are definitions only</small>
          </div>
        </div>
      </section>
      <div className="connector-grid" data-testid="connector-grid">
        {projection.connectors.map((connector) => (
          <article
            className="surface connector-card"
            data-testid="connector-card"
            key={connector.id}
          >
            <header>
              <span className="connector-letter" aria-hidden="true">
                {connector.name[0]}
              </span>
              <div>
                <h2>{connector.name}</h2>
                <p>{connector.account}</p>
              </div>
              <ModeChip
                mode={connector.mode}
                testId={`capability-mode-${connector.id}`}
              />
            </header>
            <p>{connector.detail}</p>
            <dl>
              <div>
                <dt>Health</dt>
                <dd>{connector.health}</dd>
              </div>
              <div>
                <dt>Last evidence</dt>
                <dd>{connector.lastSync}</dd>
              </div>
            </dl>
            <div className="capability-tags">
              {connector.capabilities.map((capability) => (
                <span key={capability}>{capability}</span>
              ))}
            </div>
            {connector.mode === 'blocked' ? (
              <span
                className="button button--tertiary button--full"
                aria-disabled="true"
              >
                Not available in evaluator mode
              </span>
            ) : (
              <Link
                className="button button--tertiary button--full"
                to="/evidence#connections"
              >
                Inspect evidence <ExternalLink aria-hidden="true" size={15} />
              </Link>
            )}
          </article>
        ))}
      </div>
      <section className="surface runtime-health">
        <div>
          <CloudCog aria-hidden="true" size={21} />
          <div>
            <strong>Hosted runtime boundary</strong>
            <span>
              {apiState.kind === 'ready'
                ? 'Typed system.health responded successfully.'
                : apiState.kind === 'checking'
                  ? 'Checking the typed system.health boundary.'
                  : 'Typed hosted API unavailable; deterministic local fixture remains usable.'}
            </span>
          </div>
        </div>
        <span className={`api-indicator api-indicator--${apiState.kind}`}>
          <span />
          {apiState.kind === 'ready'
            ? 'Hosted durable API healthy'
            : apiState.kind === 'checking'
              ? 'Checking'
              : 'Local fallback active'}
        </span>
      </section>
    </div>
  );
}

function EvidencePage({
  apiState,
  apiBaseUrl,
  projection,
}: {
  readonly apiState: ApiState;
  readonly apiBaseUrl: string;
  readonly projection: ProductProjection;
}) {
  const asanaAcceptanceEvidenceUrl = `${apiBaseUrl.replace(/\/$/u, '')}/trpc/system.asanaAcceptanceEvidence?batch=1&input=${encodeURIComponent(
    JSON.stringify({ 0: { json: null } }),
  )}`;
  return (
    <div className="page">
      <PageHeader
        eyebrow="Evaluator guide"
        title="Evidence, safety & Cursor access"
        description="Verify the product’s boundaries, repeat the authenticated journey, and connect a fixed-scope MCP client without exposing credentials."
      />
      <section className="evidence-hero" id="capabilities">
        <div>
          <ModeChip mode="fixture" />
          <h2>What this public session proves</h2>
          <p>
            {projection.source === 'hosted_durable'
              ? 'A deterministic evaluator can inspect and search a 1,120-message corpus across seven hosted synthetic channels, then exercise the two typed evidence anchors through grounded recommendation, durable revision, server-authorized approval, outbox receipt, Asana preparation, SLA, and audit flows without gaining external-effect authority.'
              : projection.source === 'local_fallback'
                ? 'The local fallback demonstrates the interface with static multi-channel examples only. It is not durable hosted evidence and cannot grant approval or external-effect authority.'
                : 'The evaluator is checking the hosted multichannel projection. No hosted evidence is claimed until that read succeeds.'}
          </p>
          <small>
            Demonstration-only synthetic data; external provider effects remain
            disabled.
          </small>
        </div>
        <dl>
          <div>
            <dt>Release</dt>
            <dd className="mono">chief-fixture-2026-07-17</dd>
          </div>
          <div>
            <dt>Dataset</dt>
            <dd>
              {(
                projection.metrics?.totalCommunications ??
                projection.communications.length
              ).toLocaleString('en-US')}{' '}
              {projection.source === 'hosted_durable'
                ? 'durable hosted multichannel communications'
                : 'local fallback demonstration communications'}
            </dd>
          </div>
          <div>
            <dt>External effects</dt>
            <dd>Disabled at execution guard</dd>
          </div>
          <div>
            <dt>Typed API</dt>
            <dd>
              {apiState.kind === 'ready'
                ? 'Healthy · bounded read/propose fixture surface'
                : apiState.kind === 'checking'
                  ? 'Checking'
                  : 'Unavailable · local fallback labeled'}
            </dd>
          </div>
        </dl>
      </section>
      <div className="evidence-grid" id="connections">
        <section className="surface proof-matrix" id="retrieval">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Evaluator journey</p>
              <h2>Repeatable proof points</h2>
            </div>
            <FileCheck2 aria-hidden="true" size={20} />
          </div>
          <ol>
            <li>
              <span>01</span>
              <div>
                <strong>Capability truth</strong>
                <p>
                  Open Connections and inspect the six fixture cards and one
                  recorded LinkedIn archive card. Each card is account-scoped,
                  synthetic, and effect-disabled.
                </p>
              </div>
              <Link to="/connections">
                Open <ArrowRight size={14} />
              </Link>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>Grounded action</strong>
                <p>
                  Open Taylor’s thread; inspect citations and request missing
                  context.
                </p>
              </div>
              <Link to="/inbox/thread-q3-launch">
                Open <ArrowRight size={14} />
              </Link>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>Immutable approval</strong>
                <p>
                  Revise the draft and approve only the current exact revision.
                </p>
              </div>
              <Link to="/approvals">
                Open <ArrowRight size={14} />
              </Link>
            </li>
            <li>
              <span>04</span>
              <div>
                <strong>Safe execution</strong>
                <p>
                  Confirm the effect-disabled receipt and prepared-only Asana
                  state.
                </p>
              </div>
              <Link to="/approvals">
                Open <ArrowRight size={14} />
              </Link>
            </li>
          </ol>
        </section>
        <section className="surface boundary-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Access boundary</p>
              <h2>Deliberately unavailable</h2>
            </div>
            <LockKeyhole aria-hidden="true" size={20} />
          </div>
          <ul>
            <li>
              <Check size={15} />
              No live provider credentials or token fragments
            </li>
            <li>
              <Check size={15} />
              No client-controlled tenant/account selector
            </li>
            <li>
              <Check size={15} />
              No direct send, approve, create-task, or update-task MCP tool
            </li>
            <li>
              <Check size={15} />
              No silent fixture-to-live relabeling
            </li>
            <li>
              <Check size={15} />
              No provider or Asana endpoint authority
            </li>
          </ul>
          <p>
            Separate from this effect-disabled runtime, one bounded, explicitly
            authorized controlled Asana live acceptance is published as a
            redacted, hash-bound receipt.{' '}
            <a
              href={asanaAcceptanceEvidenceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Asana controlled acceptance evidence (read-only){' '}
              <ExternalLink aria-hidden="true" size={14} />
            </a>
          </p>
        </section>
      </div>

      <section
        className="surface mcp-guide"
        id="mcp"
        data-testid="mcp-instructions"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">Cursor / remote MCP</p>
            <h2>Connect to the fixed-scope evaluator endpoint</h2>
          </div>
          <Code2 aria-hidden="true" size={21} />
        </div>
        <p className="mcp-intro">
          Use the hosted MCP URL from the deployment output with a short-lived
          bearer access token. Browser access uses an opaque session cookie;
          that cookie is never reused as MCP authority. Never paste a bearer
          token into the URL, source, or chat.
        </p>
        <div className="mcp-steps">
          <article>
            <span>1</span>
            <div>
              <strong>Open Cursor MCP settings</strong>
              <p>
                Choose <em>Add custom MCP server</em> and select Streamable
                HTTP.
              </p>
            </div>
          </article>
          <article>
            <span>2</span>
            <div>
              <strong>Enter the deployed endpoint</strong>
              <code>https://&lt;hosted-api&gt;/mcp</code>
              <p>
                Use the release output exactly. Do not add query-string
                credentials.
              </p>
            </div>
          </article>
          <article>
            <span>3</span>
            <div>
              <strong>Confirm evaluator scope</strong>
              <p>
                Verify the endpoint is labeled deterministic, non-PII, and
                effect-disabled. No account selection is offered.
              </p>
            </div>
          </article>
          <article>
            <span>4</span>
            <div>
              <strong>Verify the safe tool list</strong>
              <p>
                Read context, search knowledge, recommend, draft, revise, and
                poll an existing proposal with get_approval_status.
              </p>
            </div>
          </article>
        </div>
        <div className="tool-list" aria-label="Expected MCP tools">
          <span>list_pending_communications</span>
          <span>get_thread_context</span>
          <span>search_knowledge</span>
          <span>recommend_action</span>
          <span>create_draft</span>
          <span>revise_draft</span>
          <span>prepare_asana_action</span>
          <span>get_approval_status</span>
        </div>
        <div className="mcp-warning">
          <ShieldCheck aria-hidden="true" size={18} />
          <div>
            <strong>Approval stays in the product.</strong>
            <p>
              Prepare and approve through the server-authorized product browser
              or API. MCP can poll get_approval_status for the proposal created
              there; it cannot prepare or approve that proposal, and external
              effects remain disabled.
            </p>
          </div>
        </div>
      </section>

      <section className="surface audit-evidence" data-testid="audit-timeline">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Audit vocabulary</p>
            <h2>Observable state, not hidden reasoning</h2>
          </div>
          <Activity aria-hidden="true" size={20} />
        </div>
        <div className="audit-columns">
          <div>
            <strong>Recommendation receipt</strong>
            <p>
              Sources, policy/schema versions, confidence, and outcome are
              visible. Private chain-of-thought is not.
            </p>
          </div>
          <div>
            <strong>Approval receipt</strong>
            <p>
              Actor, exact revision hash, recipients, side effects, expiry, and
              invalidation are explicit.
            </p>
          </div>
          <div>
            <strong>Execution receipt</strong>
            <p>
              Operation, idempotency, preflight, transport outcome, and effect
              policy are explicit.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="page not-found">
      <Search aria-hidden="true" size={34} />
      <p className="eyebrow">Route not found</p>
      <h1>This communication view does not exist.</h1>
      <p>Return to the evaluator overview or unified inbox.</p>
      <div>
        <Link className="button button--primary" to="/overview">
          Open overview
        </Link>
        <Link className="button button--secondary" to="/inbox">
          Open inbox
        </Link>
      </div>
    </div>
  );
}

export function App() {
  const configuredApiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').trim();
  const production = import.meta.env.PROD;
  const apiBaseUrl = resolveBrowserApiBaseUrl({
    productOrigin: window.location.origin,
    configuredDevelopmentBaseUrl: configuredApiBaseUrl,
    production,
  });
  const api = useMemo(() => createBrowserApi(apiBaseUrl), [apiBaseUrl]);
  const apiClient = useMemo(
    () => createApiClient({ baseUrl: apiBaseUrl }),
    [apiBaseUrl],
  );
  const [apiState, setApiState] = useState<ApiState>({ kind: 'checking' });
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string>();
  const [knownProposals, setKnownProposals] = useState<
    readonly KnownProposalReference[]
  >([]);
  const [projection, setProjection] = useState<ProductProjection>({
    source: 'checking',
    communications: [],
    hostedCommunications: [],
    connectors: [],
  });
  useEffect(() => {
    let active = true;
    const load = async () => {
      const [health, metrics, communicationResult, connectorResult] =
        await Promise.allSettled([
          api.systemHealth(),
          api.dashboardMetrics('7d'),
          api.listCommunications({ limit: 100 }),
          api.getConnectorStatus(),
        ] as const);
      if (!active) return;

      const failures = [
        health,
        metrics,
        communicationResult,
        connectorResult,
      ].filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      if (failures.some(({ reason }) => isAuthenticationRequired(reason))) {
        setApiState({ kind: 'unauthenticated' });
        setProjection({
          source: 'checking',
          communications: [],
          hostedCommunications: [],
          connectors: [],
        });
        return;
      }
      if (failures.length > 0) {
        const onlyNetworkFailures = failures.every(({ reason }) =>
          isBrowserNetworkFailure(reason),
        );
        setApiState({ kind: 'unavailable' });
        setProjection(
          !production && onlyNetworkFailures
            ? {
                source: 'local_fallback',
                communications,
                hostedCommunications: [],
                connectors,
              }
            : {
                source: 'checking',
                communications: [],
                hostedCommunications: [],
                connectors: [],
              },
        );
        return;
      }
      if (
        health.status !== 'fulfilled' ||
        metrics.status !== 'fulfilled' ||
        communicationResult.status !== 'fulfilled' ||
        connectorResult.status !== 'fulfilled'
      ) {
        return;
      }

      setApiState({ kind: 'ready', health: health.value });
      setProjection({
        source: 'hosted_durable',
        metrics: metrics.value,
        communications: communicationResult.value.items.map(
          hostedCommunicationToView,
        ),
        hostedCommunications: communicationResult.value.items,
        connectors: connectorResult.value.map(hostedConnectorToView),
      });
    };
    void load();
    return () => {
      active = false;
    };
  }, [api, bootstrapAttempt, production]);

  const retryBootstrap = () => {
    setApiState({ kind: 'checking' });
    setBootstrapAttempt((attempt) => attempt + 1);
  };

  const observeProposal = useCallback((proposal: KnownProposalReference) => {
    setKnownProposals((current) => [
      proposal,
      ...current.filter(({ proposalId }) => proposalId !== proposal.proposalId),
    ]);
  }, []);

  const logout = async () => {
    setLoggingOut(true);
    setLogoutError(undefined);
    try {
      await revokeBrowserSession();
      setProjection({
        source: 'checking',
        communications: [],
        hostedCommunications: [],
        connectors: [],
      });
      setKnownProposals([]);
      setApiState({ kind: 'unauthenticated' });
    } catch {
      setLogoutError('Sign out failed. Please try again.');
    } finally {
      setLoggingOut(false);
    }
  };

  if (apiState.kind !== 'ready' && projection.source === 'checking') {
    return <BrowserAccessState kind={apiState.kind} onRetry={retryBootstrap} />;
  }

  return (
    <AppShell
      apiState={apiState}
      source={projection.source}
      pendingApprovalCount={projection.metrics?.pendingApprovalCount ?? 0}
      loggingOut={loggingOut}
      logoutError={logoutError}
      onLogout={() => void logout()}
    >
      <Routes>
        <Route path="/" element={<Navigate replace to="/overview" />} />
        <Route
          path="/overview"
          element={<OverviewPage projection={projection} />}
        />
        <Route
          path="/inbox"
          element={<InboxPage api={api} projection={projection} />}
        />
        <Route
          path="/recommended"
          element={<RecommendedActionsPage api={api} projection={projection} />}
        />
        <Route
          path="/inbox/:threadId"
          element={
            <RoutedThreadPage
              api={api}
              apiClient={apiClient}
              onProposalObserved={observeProposal}
              projection={projection}
            />
          }
        />
        <Route
          path="/communications/:messageRevisionId"
          element={
            <RoutedThreadPage
              api={api}
              apiClient={apiClient}
              onProposalObserved={observeProposal}
              projection={projection}
              routeKind="communication"
            />
          }
        />
        <Route
          path="/threads/:threadId"
          element={
            <RoutedThreadPage
              api={api}
              apiClient={apiClient}
              onProposalObserved={observeProposal}
              projection={projection}
              routeKind="thread"
            />
          }
        />
        <Route
          path="/attachments/:attachmentId"
          element={<AttachmentInboxAlias api={api} projection={projection} />}
        />
        <Route
          path="/approvals"
          element={
            <ApprovalsPage
              api={api}
              knownProposals={knownProposals}
              projection={projection}
            />
          }
        />
        <Route
          path="/approvals/:proposalId"
          element={<ApprovalStatusPage apiClient={apiClient} />}
        />
        <Route
          path="/connections"
          element={
            <ConnectionsPage apiState={apiState} projection={projection} />
          }
        />
        <Route
          path="/settings/connectors/:connectorId"
          element={
            <ConnectionsPage apiState={apiState} projection={projection} />
          }
        />
        <Route
          path="/evidence"
          element={
            <EvidencePage
              apiState={apiState}
              apiBaseUrl={apiBaseUrl}
              projection={projection}
            />
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}
