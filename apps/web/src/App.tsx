import { useEffect, useMemo, useState } from 'react';
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

import {
  createBrowserApi,
  type BrowserApi,
  type BrowserDashboardMetrics,
} from '@chief/browser-api';
import type {
  CommunicationDetailView,
  CommunicationSummaryView,
  ConnectorStatusView,
  CitedDraftResult,
  HealthResponse,
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

type ApiState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly health: HealthResponse }
  | { readonly kind: 'unavailable' };

type WorkflowState = 'draft' | 'revised' | 'approved';
type InboxFilter = 'all' | CommunicationStatus;
type ProjectionSource = 'checking' | 'hosted_fixture' | 'local_fallback';

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
  { to: '/approvals', label: 'Approvals', Icon: ClipboardCheck },
  { to: '/connections', label: 'Connections', Icon: Waypoints },
  { to: '/evidence', label: 'Evidence & help', Icon: BookOpenCheck },
] as const;

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
  const channel = communication.threadId === 'thread-3' ? 'SMS' : 'Email';

  return {
    id:
      hostedEvaluatorRoutes[communication.messageRevisionId] ??
      `${communication.threadId}--${communication.messageRevisionId}`,
    threadId: communication.threadId,
    messageRevisionId: communication.messageRevisionId,
    sender: communication.senderDisplayName ?? 'Unknown sender',
    subject: communication.subject ?? 'Communication without subject',
    excerpt: communication.excerpt,
    channel,
    account: 'Hosted assessment fixture',
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
  children,
}: {
  readonly apiState: ApiState;
  readonly source: ProjectionSource;
  readonly children: React.ReactNode;
}) {
  const location = useLocation();
  const routeLabel =
    navItems.find((item) => location.pathname.startsWith(item.to))?.label ??
    'Communication detail';

  const apiLabel =
    apiState.kind === 'ready'
      ? 'Hosted fixture API healthy'
      : apiState.kind === 'checking'
        ? 'Checking hosted API'
        : 'Hosted API unavailable · local fallback';
  const sourceLabel =
    source === 'hosted_fixture'
      ? 'Hosted assessment fixture.'
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
                <span className="nav-count">6</span>
              ) : null}
            </NavLink>
          ))}
        </nav>

        <section className="sidebar-proof" aria-label="Evaluator mode">
          <div className="sidebar-proof-title">
            <ShieldCheck aria-hidden="true" size={17} />
            <strong>Safe evaluator</strong>
          </div>
          <p>Signed out · deterministic fixture · external effects disabled.</p>
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
        </div>
      </aside>

      <div className="app-body">
        <div className="truth-banner" role="status">
          <Info aria-hidden="true" size={16} />
          <span>
            <strong>{sourceLabel}</strong> Workflow records are deterministic
            and non-live. The public API supports bounded reads and proposal
            preparation, but no approval or external mutation; the local
            ceremony produces an effect-disabled receipt only.
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
          {navItems.map(({ to, label, Icon }) => (
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

function OverviewPage({
  projection,
}: {
  readonly projection: ProductProjection;
}) {
  const snapshot = projection.metrics?.snapshot;
  const isHosted = projection.source === 'hosted_fixture';
  const totalCommunications =
    projection.metrics?.totalCommunications ?? communications.length;
  const answeredCount = snapshot?.answeredCount ?? 1_219;
  const resolvedCount = snapshot?.resolvedCount ?? 0;
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
      value: (snapshot?.pendingCount ?? 47).toLocaleString('en-US'),
      note: `${projection.metrics?.pendingApprovalCount ?? 6} awaiting approval`,
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
      value: (snapshot?.overdueCount ?? 18).toLocaleString('en-US'),
      note: isHosted ? 'Hosted fixture projection' : '4 critical priority',
      Icon: BellRing,
    },
  ] as const;

  return (
    <div className="page page--overview">
      <PageHeader
        eyebrow="Executive briefing · Friday, 17 July 2026"
        title="Good morning, Alex."
        description={`${(snapshot?.pendingCount ?? 47).toLocaleString('en-US')} communications need attention. The overdue queue is separated from answered and resolved work.`}
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
              View all 47
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
              <p className="eyebrow">Recent activity</p>
              <h2 id="actions-heading">Execution & audit</h2>
            </div>
            <Activity aria-hidden="true" size={20} />
          </div>
          <ol className="activity-list" data-testid="audit-timeline">
            <li>
              <span className="activity-mark activity-mark--safe">
                <Check size={12} />
              </span>
              <div>
                <strong>Pricing exception acknowledged</strong>
                <p>
                  Effect-disabled receipt · synthetic provider-shaped SMS
                  fixture
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

function InboxPage({ projection }: { readonly projection: ProductProjection }) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [query, setQuery] = useState('');
  const filtered = projection.communications.filter((item) => {
    const matchesStatus = filter === 'all' || item.status === filter;
    const normalized = query.trim().toLowerCase();
    const matchesQuery =
      normalized.length === 0 ||
      `${item.sender} ${item.subject} ${item.channel}`
        .toLowerCase()
        .includes(normalized);
    return matchesStatus && matchesQuery;
  });

  return (
    <div className="page">
      <PageHeader
        eyebrow="Unified communications"
        title="Inbox"
        description="One queue across channel-shaped assessment records. Every row retains its source mode and answered state."
        action={
          <span className="fixture-summary">
            <ModeChip mode="fixture" />
            {projection.communications.length.toLocaleString('en-US')}{' '}
            {projection.source === 'hosted_fixture'
              ? 'hosted fixture records'
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
              <option value="context">Needs context</option>
              <option value="answered">Answered</option>
              <option value="resolved">Resolved</option>
            </select>
            <ChevronDown aria-hidden="true" size={15} />
          </label>
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
          {filtered.length === 0 ? (
            <EmptyState filter={filter} />
          ) : (
            filtered.map((item) => (
              <button
                className="inbox-row"
                data-testid={`inbox-row-${item.id}`}
                key={item.id}
                type="button"
                onClick={() => {
                  void navigate(`/inbox/${item.id}`);
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

function RoutedThreadPage({
  api,
  projection,
  workflow,
  setWorkflow,
}: {
  readonly api: BrowserApi;
  readonly projection: ProductProjection;
  readonly workflow: WorkflowState;
  readonly setWorkflow: (state: WorkflowState) => void;
}) {
  const { threadId = '' } = useParams();
  if (projection.source === 'checking') {
    return (
      <div className="page not-found" role="status">
        <RefreshCcw aria-hidden="true" size={34} />
        <p className="eyebrow">Checking hosted fixture</p>
        <h1>Loading the exact communication route.</h1>
        <p>No substitute thread is displayed while the typed API responds.</p>
      </div>
    );
  }
  const communication = projection.communications.find(
    ({ id }) => id === threadId,
  );

  if (
    projection.source === 'local_fallback' &&
    threadId === 'thread-q3-launch'
  ) {
    return <ThreadPage workflow={workflow} setWorkflow={setWorkflow} />;
  }

  return (
    <ProjectionThreadPage
      api={api}
      communication={communication}
      source={projection.source}
      workflow={workflow}
      setWorkflow={setWorkflow}
    />
  );
}

function ProjectionThreadPage({
  api,
  communication,
  source,
  workflow,
  setWorkflow,
}: {
  readonly api: BrowserApi;
  readonly communication?: CommunicationFixture;
  readonly source: ProjectionSource;
  readonly workflow: WorkflowState;
  readonly setWorkflow: (state: WorkflowState) => void;
}) {
  const navigate = useNavigate();
  const [state, setState] = useState<HostedThreadState>({ kind: 'loading' });
  const [contextOutcome, setContextOutcome] = useState<string>();
  const [proposalOutcome, setProposalOutcome] = useState<string>();
  const [draftInput, setDraftInput] = useState('');
  const [submittedDraft, setSubmittedDraft] = useState<string>();

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
      source !== 'hosted_fixture' ||
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
          if (draft !== undefined) setDraftInput(draft.draft.body);
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
    setSubmittedDraft(draftInput);
    void api
      .reviseDraft({
        draftRevisionId: state.draft.draft.draftRevisionId,
        expectedDraftRevision: state.draft.draft.revision,
        revisionInstruction:
          'Make the response shorter and retain cited facts.',
      })
      .then(
        (draft) => {
          setState((current) => ({ ...current, draft }));
          setDraftInput(draft.draft.body);
          setWorkflow('revised');
        },
        () => {
          setProposalOutcome('Hosted draft revision could not be prepared.');
        },
      );
  };

  const prepareAsana = () => {
    if (state.recommendation === undefined) return;
    void api
      .prepareAsanaAction(
        state.recommendation.recommendationId,
        state.recommendation.revision,
      )
      .then(
        (proposal) => {
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
        eyebrow={`${source === 'hosted_fixture' ? 'Hosted fixture' : 'Local fallback'} · ${communication.received} UTC`}
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
                  {contextOutcome} No notification or external mutation
                  occurred.
                </p>
              )}
            </>
          )}

          {state.draft === undefined ? null : (
            <div className="hosted-draft">
              <label htmlFor="hosted-draft-editor">
                Hosted fixture draft revision {state.draft.draft.revision}
              </label>
              <textarea
                id="hosted-draft-editor"
                data-testid="draft-editor"
                rows={7}
                value={draftInput}
                onChange={(event) => {
                  setDraftInput(event.target.value);
                  setWorkflow('draft');
                }}
              />
              <div className="draft-meta">
                <span>Style profile · concise · direct</span>
                <span>
                  {state.draft.factualCitationCount} factual citations
                </span>
                <span>Hosted fixture proposal</span>
              </div>
              <button
                className="button button--secondary button--full"
                type="button"
                onClick={reviseDraft}
              >
                <PencilLine aria-hidden="true" size={16} /> Revise for brevity
              </button>
            </div>
          )}

          {workflow === 'draft' || submittedDraft === undefined ? null : (
            <div className="diff-card" data-testid="revision-diff">
              <strong>Local immutable ceremony revision</strong>
              <p>{submittedDraft}</p>
              <span>
                The hosted API prepared the cited revision; no provider effect
                is authorized.
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
              <strong>Public API cannot approve or execute.</strong>
              <p>
                The button below demonstrates the deterministic local ceremony;
                it can produce only an effect-disabled receipt.
              </p>
            </div>
          </div>
          {workflow === 'approved' ? (
            <ExecutionReceipt />
          ) : (
            <button
              className="button button--primary button--full"
              data-testid="approve-action"
              type="button"
              disabled={workflow !== 'revised'}
              onClick={() => setWorkflow('approved')}
            >
              <UserRoundCheck aria-hidden="true" size={17} /> Complete local
              effect-disabled ceremony
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

function ThreadPage({
  workflow,
  setWorkflow,
}: {
  readonly workflow: WorkflowState;
  readonly setWorkflow: (state: WorkflowState) => void;
}) {
  const [draft, setDraft] = useState(
    workflow === 'draft' ? initialDraft : revisedDraft,
  );
  const [contextOpen, setContextOpen] = useState(false);
  const navigate = useNavigate();

  const revise = () => {
    setDraft(revisedDraft);
    setWorkflow('revised');
  };

  const approve = () => setWorkflow('approved');

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
                  <small>Gmail · linked to SEC-4821</small>
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
                  <strong>SEC-4821 · Enterprise pilot security review</strong>
                  <span>In review · due today · owner Priya Shah</span>
                </div>
              </div>
              <InlineLink>Open fixture task context</InlineLink>
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
                <h2>Revision {workflow === 'draft' ? '1' : '2'}</h2>
              </div>
              <span className="style-chip">Direct · concise · no hedging</span>
            </div>
            <label htmlFor="draft-editor">Reply body</label>
            <textarea
              id="draft-editor"
              data-testid="draft-editor"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setWorkflow('draft');
              }}
              rows={12}
            />
            <div className="draft-meta">
              <span>Style profile v12</span>
              <span>3 factual citations</span>
              <span>Renderer: email-text v1</span>
            </div>
            <button
              className="button button--secondary button--full"
              type="button"
              onClick={revise}
            >
              <PencilLine aria-hidden="true" size={16} /> Revise for brevity
            </button>
          </article>

          {workflow === 'draft' ? null : (
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
                <dd>Prepare comment for SEC-4821 · disabled</dd>
              </div>
              <div>
                <dt>Revision hash</dt>
                <dd className="mono">8e41…a29c · revision 2</dd>
              </div>
            </dl>
            {workflow === 'approved' ? (
              <div className="approved-state">
                <CheckCircle2 aria-hidden="true" size={18} />
                <div>
                  <strong>Exact revision approved</strong>
                  <span>Approval fx-apr-7721 · 09:44 UTC</span>
                </div>
              </div>
            ) : (
              <button
                className="button button--primary button--full"
                data-testid="approve-action"
                type="button"
                disabled={workflow === 'draft'}
                onClick={approve}
              >
                <UserRoundCheck aria-hidden="true" size={17} /> Approve revision
                2
              </button>
            )}
            {workflow === 'draft' ? (
              <p className="approval-help">
                Create revision 2 before approval. Edits always invalidate prior
                approval.
              </p>
            ) : null}
          </article>

          {workflow === 'approved' ? <ExecutionReceipt /> : null}
        </section>
      </div>
    </div>
  );
}

function ExecutionReceipt() {
  return (
    <article className="surface receipt-card" data-testid="execution-receipt">
      <div className="receipt-status">
        <CheckCircle2 aria-hidden="true" size={21} />
        <div>
          <strong>Execution completed safely</strong>
          <span>
            Effect-disabled receipt · no provider or Asana request occurred
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
          <dd className="mono">fx-op-7c41</dd>
        </div>
        <div>
          <dt>Idempotency</dt>
          <dd>Replays return this receipt</dd>
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
          <span>SEC-4821 comment plan retained · external task unchanged</span>
        </div>
        <ModeChip mode="fixture" />
      </section>
      <ol className="mini-timeline" data-testid="audit-timeline">
        <li>
          <span />
          <div>
            <strong>09:44:02</strong> Approval bound to revision hash
          </div>
        </li>
        <li>
          <span />
          <div>
            <strong>09:44:03</strong> Outbox operation claimed once
          </div>
        </li>
        <li>
          <span />
          <div>
            <strong>09:44:03</strong> Preflight confirmed effect switch off
          </div>
        </li>
        <li>
          <span />
          <div>
            <strong>09:44:03</strong> Receipt persisted; no external call
          </div>
        </li>
      </ol>
    </article>
  );
}

function ApprovalsPage({
  workflow,
  setWorkflow,
}: {
  readonly workflow: WorkflowState;
  readonly setWorkflow: (state: WorkflowState) => void;
}) {
  return (
    <div className="page">
      <PageHeader
        eyebrow="Human control plane"
        title="Pending approvals"
        description="External actions are never approved implicitly. This signed-out ceremony is local and effect-disabled; the public API can prepare proposals but cannot approve or execute them."
      />
      <div className="approval-page-grid">
        <section className="surface approval-queue">
          <div className="section-heading">
            <div>
              <p className="eyebrow">6 pending</p>
              <h2>Action plans</h2>
            </div>
            <Filter aria-hidden="true" size={18} />
          </div>
          <Link
            className="approval-row approval-row--active"
            to="/inbox/thread-q3-launch"
          >
            <span className="queue-icon queue-icon--overdue">
              <Send size={16} />
            </span>
            <div>
              <strong>Reply to Taylor Reed</strong>
              <p>Q3 launch risk and customer note</p>
              <small>
                Gmail fixture · revision {workflow === 'draft' ? '1' : '2'} · 2
                side effects
              </small>
            </div>
            <StatusChip status="overdue" />
          </Link>
          <div className="approval-row">
            <span className="queue-icon">
              <ListChecks size={16} />
            </span>
            <div>
              <strong>Update board packet task</strong>
              <p>Operating metrics sensitivity page</p>
              <small>Asana fixture · 1 side effect</small>
            </div>
            <StatusChip status="pending" />
          </div>
          <div className="approval-row">
            <span className="queue-icon">
              <MessageSquareText size={16} />
            </span>
            <div>
              <strong>Acknowledge partner meeting</strong>
              <p>Owner context required first</p>
              <small>WhatsApp fixture · not approvable</small>
            </div>
            <StatusChip status="context" />
          </div>
        </section>
        <section className="surface approval-focus">
          <p className="eyebrow">Selected action</p>
          <h2>Reply + Asana follow-up</h2>
          <p className="approval-summary">
            The selected action is bound to a fixture recipient, revision hash,
            Gmail-shaped renderer, and prepared Asana comment. Neither operation
            can reach an external endpoint in this session.
          </p>
          <dl className="approval-plan">
            <div>
              <dt>Recipient</dt>
              <dd>Taylor Reed · fixture identity</dd>
            </div>
            <div>
              <dt>Draft</dt>
              <dd>
                Revision{' '}
                {workflow === 'draft' ? '1 (must revise)' : '2 · 8e41…a29c'}
              </dd>
            </div>
            <div>
              <dt>Message outcome</dt>
              <dd>effect_disabled</dd>
            </div>
            <div>
              <dt>Asana outcome</dt>
              <dd>Prepared only</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>10:14 UTC · 30 minutes</dd>
            </div>
          </dl>
          {workflow === 'draft' ? (
            <button
              className="button button--primary button--full"
              type="button"
              onClick={() => setWorkflow('revised')}
            >
              <PencilLine size={16} /> Create immutable revision 2
            </button>
          ) : workflow === 'revised' ? (
            <button
              className="button button--primary button--full"
              data-testid="approve-action"
              type="button"
              onClick={() => setWorkflow('approved')}
            >
              <UserRoundCheck size={17} /> Approve exact action plan
            </button>
          ) : (
            <ExecutionReceipt />
          )}
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

  return (
    <div className="page">
      <PageHeader
        eyebrow="Onboarding & capability truth"
        title="Connections"
        description="Understand what is operational, evidenced, simulated, or externally blocked before relying on a channel."
        action={
          <button className="button button--secondary" type="button">
            <Plus aria-hidden="true" size={17} /> Connection guide
          </button>
        }
      />
      <section className="mode-legend" aria-label="Capability mode legend">
        <article>
          <ModeChip mode="live" testId="capability-mode-legend-live" />
          <strong>{modeCount('live')} in this session</strong>
          <span>Current provider connection with direct runtime proof</span>
        </article>
        <article>
          <ModeChip mode="recorded" testId="capability-mode-legend-recorded" />
          <strong>{modeCount('recorded')} evidence sets</strong>
          <span>Prior provider-shaped receipt; no current call</span>
        </article>
        <article>
          <ModeChip mode="fixture" testId="capability-mode-legend-fixture" />
          <strong>{modeCount('fixture')} deterministic adapters</strong>
          <span>Local seeded records with external effects disabled</span>
        </article>
        <article>
          <ModeChip mode="blocked" testId="capability-mode-legend-blocked" />
          <strong>{modeCount('blocked')} authorization gates</strong>
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
            <strong>1. Review scope</strong>
            <small>Fixture tenant is selected</small>
          </div>
        </div>
        <div className="onboarding-line" />
        <div className="onboarding-step onboarding-step--current">
          <span>2</span>
          <div>
            <strong>Inspect capabilities</strong>
            <small>Modes are independently labeled</small>
          </div>
        </div>
        <div className="onboarding-line" />
        <div className="onboarding-step">
          <span>3</span>
          <div>
            <strong>Authorize live account</strong>
            <small>Unavailable while signed out</small>
          </div>
        </div>
      </section>
      <div className="connector-grid">
        {projection.connectors.map((connector) => (
          <article className="surface connector-card" key={connector.id}>
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
            <button
              className="button button--tertiary button--full"
              type="button"
              disabled={connector.mode === 'blocked'}
            >
              {connector.mode === 'blocked'
                ? 'Authorization required'
                : 'Inspect evidence'}{' '}
              <ExternalLink aria-hidden="true" size={15} />
            </button>
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
            ? 'Hosted fixture API healthy'
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
  projection,
}: {
  readonly apiState: ApiState;
  readonly projection: ProductProjection;
}) {
  return (
    <div className="page">
      <PageHeader
        eyebrow="Evaluator guide"
        title="Evidence, safety & Cursor access"
        description="Verify the product’s boundaries, repeat the signed-out journey, and connect an authenticated MCP client without exposing credentials."
      />
      <section className="evidence-hero" id="capabilities">
        <div>
          <ModeChip mode="fixture" />
          <h2>What this public session proves</h2>
          <p>
            A deterministic evaluator can inspect a cross-channel inbox,
            grounded recommendation, style-matched revision, explicit approval,
            outbox receipt, Asana preparation, SLA, and audit trail without
            gaining external-effect authority.
          </p>
        </div>
        <dl>
          <div>
            <dt>Release</dt>
            <dd className="mono">chief-fixture-2026-07-17</dd>
          </div>
          <div>
            <dt>Dataset</dt>
            <dd>
              {projection.communications.length.toLocaleString('en-US')}{' '}
              {projection.source === 'hosted_fixture'
                ? 'hosted fixture communications'
                : 'local fallback communications'}
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
      <div className="evidence-grid">
        <section className="surface proof-matrix">
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
                  Open Connections and compare fixture, recorded, and blocked
                  modes.
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
              No tenant/account selector in signed-out mode
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
            <h2>Connect through the authenticated product flow</h2>
          </div>
          <Code2 aria-hidden="true" size={21} />
        </div>
        <p className="mcp-intro">
          Use the hosted MCP URL from the deployed evidence manifest. Cursor
          discovers OAuth metadata and opens the product authorization flow;
          never paste a bearer token into the URL, source, or chat.
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
              <strong>Complete browser authorization</strong>
              <p>
                Grant only the tenant, accounts, and read/preparation scopes
                shown.
              </p>
            </div>
          </article>
          <article>
            <span>4</span>
            <div>
              <strong>Verify the safe tool list</strong>
              <p>
                Read context, search knowledge, recommend, draft, revise, and
                prepare approval handoffs.
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
          <span>submit_for_approval</span>
        </div>
        <div className="mcp-warning">
          <ShieldCheck aria-hidden="true" size={18} />
          <div>
            <strong>Approval stays in the product.</strong>
            <p>
              MCP returns an immutable proposal ID and authenticated approval
              URL. It cannot execute a message or task directly.
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
  const apiBaseUrl =
    configuredApiBaseUrl.length > 0
      ? configuredApiBaseUrl
      : window.location.origin;
  const api = useMemo(() => createBrowserApi(apiBaseUrl), [apiBaseUrl]);
  const [apiState, setApiState] = useState<ApiState>({ kind: 'checking' });
  const [projection, setProjection] = useState<ProductProjection>({
    source: 'checking',
    communications: [],
    hostedCommunications: [],
    connectors: [],
  });
  const [workflow, setWorkflow] = useState<WorkflowState>('draft');

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [health, metrics, communicationResult, connectorResult] =
          await Promise.all([
            api.systemHealth(),
            api.dashboardMetrics('7d'),
            api.listCommunications({ limit: 100 }),
            api.getConnectorStatus(),
          ]);
        if (active) {
          setApiState({ kind: 'ready', health });
          setProjection({
            source: 'hosted_fixture',
            metrics,
            communications: communicationResult.items.map(
              hostedCommunicationToView,
            ),
            hostedCommunications: communicationResult.items,
            connectors: connectorResult.map(hostedConnectorToView),
          });
        }
      } catch {
        if (active) {
          setApiState({ kind: 'unavailable' });
          setProjection({
            source: 'local_fallback',
            communications,
            hostedCommunications: [],
            connectors,
          });
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [api]);

  return (
    <AppShell apiState={apiState} source={projection.source}>
      <Routes>
        <Route path="/" element={<Navigate replace to="/overview" />} />
        <Route
          path="/overview"
          element={<OverviewPage projection={projection} />}
        />
        <Route path="/inbox" element={<InboxPage projection={projection} />} />
        <Route
          path="/inbox/:threadId"
          element={
            <RoutedThreadPage
              api={api}
              projection={projection}
              workflow={workflow}
              setWorkflow={setWorkflow}
            />
          }
        />
        <Route
          path="/approvals"
          element={
            <ApprovalsPage workflow={workflow} setWorkflow={setWorkflow} />
          }
        />
        <Route
          path="/connections"
          element={
            <ConnectionsPage apiState={apiState} projection={projection} />
          }
        />
        <Route
          path="/evidence"
          element={<EvidencePage apiState={apiState} projection={projection} />}
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}
