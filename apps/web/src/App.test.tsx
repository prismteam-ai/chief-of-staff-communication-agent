// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import {
  communicationSummaryViewSchema,
  type CommunicationSummaryView,
} from '@chief/contracts';

import { App } from './App.js';

const {
  browserApiMock,
  createBrowserApiMock,
  apiClientMock,
  createApiClientMock,
} = vi.hoisted(() => {
  const browserApi = {
    systemHealth: vi.fn(),
    dashboardMetrics: vi.fn(),
    slaMetrics: vi.fn(),
    listCommunications: vi.fn(),
    getCommunication: vi.fn(),
    getThread: vi.fn(),
    getConnectorStatus: vi.fn(),
    getRelatedAsanaWork: vi.fn(),
    searchKnowledge: vi.fn(),
    recommendAction: vi.fn(),
    createDraft: vi.fn(),
    reviseDraft: vi.fn(),
    requestContext: vi.fn(),
    prepareApproval: vi.fn(),
    prepareAsanaAction: vi.fn(),
    getApprovalStatus: vi.fn(),
    getExecutionStatus: vi.fn(),
  };
  return {
    browserApiMock: browserApi,
    createBrowserApiMock: vi.fn(() => browserApi),
    apiClientMock: {
      approvals: {
        prepareDraft: { mutate: vi.fn() },
        approve: { mutate: vi.fn() },
        status: { query: vi.fn() },
      },
      execution: { status: { query: vi.fn() } },
    },
    createApiClientMock: vi.fn(),
  };
});

vi.mock('@chief/browser-api', () => ({
  createBrowserApi: createBrowserApiMock,
}));

vi.mock('@chief/api-client', () => ({
  createApiClient: createApiClientMock,
}));

beforeEach(() => {
  for (const method of Object.values(browserApiMock)) method.mockReset();
  for (const procedure of [
    apiClientMock.approvals.prepareDraft.mutate,
    apiClientMock.approvals.approve.mutate,
    apiClientMock.approvals.status.query,
    apiClientMock.execution.status.query,
  ]) {
    procedure.mockReset();
  }
  const networkError = new Error('BROWSER_API_NETWORK_ERROR');
  networkError.name = 'BrowserApiNetworkError';
  browserApiMock.systemHealth.mockRejectedValue(networkError);
  createBrowserApiMock.mockClear();
  createApiClientMock.mockReset();
  createApiClientMock.mockReturnValue(apiClientMock);
});

afterEach(() => {
  cleanup();
});

function renderRoute(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>,
  );
}

const hostedCommunicationItems = [
  communicationSummaryViewSchema.parse({
    messageId: 'message-1',
    messageRevisionId: 'message-revision-1-1',
    revision: 1,
    threadId: 'thread-1',
    direction: 'inbound',
    status: 'overdue',
    channel: 'gmail',
    accountId: 'account-gmail-fixture',
    brandId: 'brand-northstar',
    senderDisplayName: 'Jordan Lee',
    recipientDisplayNames: ['Avery Morgan'],
    subject: 'Friday launch decision',
    excerpt: 'Can we confirm the Friday launch and the owner for QA?',
    attachmentCount: 1,
    sourceTimestamp: '2026-07-17T10:52:00.000Z',
    productUrl: 'https://chief.example/communications/message-revision-1-1',
  }),
  communicationSummaryViewSchema.parse({
    messageId: 'message-2',
    messageRevisionId: 'message-revision-2-1',
    revision: 1,
    threadId: 'thread-2',
    direction: 'inbound',
    status: 'pending',
    channel: 'microsoft_graph',
    accountId: 'account-graph-fixture',
    brandId: 'brand-harbor',
    senderDisplayName: 'Priya Shah',
    recipientDisplayNames: ['Avery Morgan'],
    subject: 'Board update numbers',
    excerpt: 'Please send the approved pipeline numbers for the board note.',
    attachmentCount: 0,
    sourceTimestamp: '2026-07-17T11:06:00.000Z',
    productUrl: 'https://chief.example/communications/message-revision-2-1',
  }),
] as const;

/**
 * Deterministic stand-in for the hosted 1,120-message corpus: `count` distinct
 * inbound actionable threads, newest first, so the bounded recommendation
 * fan-out can be observed without the two evaluator anchor overlays.
 */
function buildActionableCorpus(
  count: number,
): readonly CommunicationSummaryView[] {
  const newestMs = Date.UTC(2026, 6, 17, 12, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const label = String(index).padStart(2, '0');
    return communicationSummaryViewSchema.parse({
      messageId: `corpus-message-${label}`,
      messageRevisionId: `corpus-message-revision-${label}`,
      revision: 1,
      threadId: `corpus-thread-${label}`,
      direction: 'inbound',
      status: index % 2 === 0 ? 'overdue' : 'pending',
      channel: 'gmail',
      accountId: 'account-gmail-fixture',
      brandId: 'brand-northstar',
      senderDisplayName: 'Corpus Sender',
      recipientDisplayNames: ['Avery Morgan'],
      subject: `Corpus actionable thread ${label}`,
      excerpt: 'Deterministic synthetic evaluator corpus message.',
      attachmentCount: 0,
      sourceTimestamp: new Date(newestMs - index * 60_000).toISOString(),
      productUrl: `https://chief.example/communications/corpus-message-revision-${label}`,
    });
  });
}

function arrangeActionableCorpus(
  corpus: readonly CommunicationSummaryView[],
): void {
  browserApiMock.listCommunications.mockImplementation(
    (input: { readonly status?: string }) => {
      if (input.status === 'overdue' || input.status === 'pending') {
        return Promise.resolve({
          items: corpus.filter((item) => item.status === input.status),
          totalCount: corpus.length,
        });
      }
      return Promise.resolve({
        items: hostedCommunicationItems,
        totalCount: 1_120,
        nextCursor: 'page-2',
      });
    },
  );
}

function buildCorpusRecommendation(messageRevisionId: string) {
  return {
    recommendationId: `recommendation-${messageRevisionId}`,
    sourceMessageRevisionId: messageRevisionId,
    revision: 1,
    actionType: 'reply',
    confidence: 0.82,
    urgency: 'normal',
    reasonSummary: 'Reply using the cited evidence for this exact thread.',
    citations: [{ citationId: `citation-${messageRevisionId}` }],
    missingFacts: [],
  };
}

function arrangeHostedProjection() {
  browserApiMock.systemHealth.mockResolvedValue({
    service: 'chief-api',
    status: 'ok',
    timestamp: '2026-07-17T12:00:00.000Z',
    foundationOnly: false,
  });
  browserApiMock.dashboardMetrics.mockResolvedValue({
    totalCommunications: 1_120,
    pendingApprovalCount: 0,
    channelBreakdown: [
      { channel: 'gmail', count: 161 },
      { channel: 'microsoft_graph', count: 161 },
      { channel: 'sms', count: 161 },
      { channel: 'whatsapp', count: 161 },
      { channel: 'x', count: 161 },
      { channel: 'linkedin_archive', count: 161 },
      { channel: 'future_demo', count: 154 },
    ],
    snapshot: {
      schemaVersion: '1',
      window: '7d',
      measuredAt: '2026-07-17T12:00:00.000Z',
      pendingCount: 1,
      overdueCount: 1,
      answeredCount: 0,
      resolvedCount: 0,
      responseTimeP50Ms: 42_000,
      responseTimeP95Ms: 118_000,
    },
  });
  browserApiMock.listCommunications.mockResolvedValue({
    items: hostedCommunicationItems,
    totalCount: 1_120,
    nextCursor: 'page-2',
  });
  browserApiMock.getConnectorStatus.mockResolvedValue(
    [
      ['gmail', 'account-gmail-fixture', 'brand-northstar'],
      ['microsoft_graph', 'account-graph-fixture', 'brand-harbor'],
      ['sms', 'account-sms-fixture', 'brand-northstar'],
      ['whatsapp', 'account-whatsapp-fixture', 'brand-harbor'],
      ['x', 'account-x-fixture', 'brand-northstar'],
      ['linkedin_archive', 'account-linkedin-fixture', 'brand-harbor'],
      ['future_demo', 'account-demo-fixture', 'brand-northstar'],
    ].map(([channel, accountId, brandId]) => ({
      accountId,
      brandId,
      connectorId: channel,
      displayLabel: `${channel} synthetic evaluator fixture`,
      provider: channel,
      connectorKind: 'communication',
      channel,
      status: 'active',
      health: 'healthy',
      runtimeMode: channel === 'linkedin_archive' ? 'manual' : 'fixture',
      selectionState: 'selected',
      capabilities: {
        read: true,
        send: false,
        webhook: false,
        poll: false,
        threads: true,
        attachments: true,
        deliveryFeedback: false,
        multipleAccounts: true,
        historicalBackfill: true,
        externalEffect: false,
        replyCorrelation: true,
        complaintFeedback: false,
        unsubscribeFeedback: false,
        optOutFeedback: false,
        reconsentFeedback: false,
        consentWindowEligibility: false,
      },
      lastSyncAt: '2026-07-17T12:00:00.000Z',
      productUrl: `https://chief.example/settings/connectors/${channel}`,
    })),
  );
}

function arrangeHostedThread() {
  const initialDraftResult = {
    draft: {
      draftRevisionId: 'draft-revision-1',
      revision: 1,
      body: 'Confirm the launch owner and the 16:00 UTC checkpoint.',
    },
    factualCitationCount: 1,
  };
  const revisedDraftResult = {
    draft: {
      draftRevisionId: 'draft-revision-2',
      revision: 2,
      body: 'Confirm the owner and review at 16:00 UTC.',
    },
    factualCitationCount: 1,
  };
  const durableReceipt = {
    kind: 'effect_disabled',
    operationId: 'operation-durable-1',
    artifactHash: 'a'.repeat(64),
    stableIdempotencyKey: 'durable-idempotency-1',
    observedAt: '2026-07-17T12:02:00.000Z',
  };
  const proposalId = 'proposal-durable-1';
  const pendingAt = '2026-07-17T12:01:00.000Z';
  const approvedAt = '2026-07-17T12:02:00.000Z';
  const approvalResult = {
    proposalId,
    approvalUrl: `https://chief.example/approvals/${proposalId}`,
    directEffectAvailable: false,
    actionPlanId: 'action-plan-durable-1',
    actionPlanRevision: 1,
    actionPlanHash: 'b'.repeat(64),
  };
  let persistedDraft = initialDraftResult;
  let preparedBinding:
    | {
        readonly draftRevisionId: string;
        readonly expectedDraftRevision: number;
      }
    | undefined;
  let approvalPersisted = false;

  arrangeHostedProjection();
  browserApiMock.getCommunication.mockResolvedValue({
    messageRevisionId: 'message-revision-1-1',
    revision: 1,
    authoredText: 'Can we confirm the Friday launch and the owner for QA?',
    attachments: [],
  });
  browserApiMock.getThread.mockResolvedValue({
    threadId: 'thread-1',
    participantDisplayNames: ['Jordan Lee', 'Avery Morgan'],
    communications: [
      {
        messageRevisionId: 'message-revision-1-1',
        senderDisplayName: 'Jordan Lee',
        excerpt: 'Can we confirm the Friday launch?',
        direction: 'inbound',
        status: 'overdue',
        sourceTimestamp: '2026-07-17T10:52:00.000Z',
      },
    ],
  });
  browserApiMock.getRelatedAsanaWork.mockResolvedValue([]);
  browserApiMock.recommendAction.mockResolvedValue({
    recommendationId: 'recommendation-1',
    revision: 1,
    actionType: 'reply',
    confidence: 0.9,
    urgency: 'high',
    reasonSummary: 'Reply with the cited launch owner and checkpoint.',
    citations: [{ citationId: 'citation-1', label: 'Decision log' }],
  });
  browserApiMock.createDraft.mockImplementation(() => {
    return Promise.resolve(persistedDraft);
  });
  browserApiMock.reviseDraft.mockImplementation(() => {
    persistedDraft = revisedDraftResult;
    return Promise.resolve(persistedDraft);
  });
  apiClientMock.approvals.prepareDraft.mutate.mockImplementation(
    (input: {
      readonly draftRevisionId: string;
      readonly expectedDraftRevision: number;
    }) => {
      const currentBinding = {
        draftRevisionId: persistedDraft.draft.draftRevisionId,
        expectedDraftRevision: persistedDraft.draft.revision,
      };
      if (
        input.draftRevisionId !== currentBinding.draftRevisionId ||
        input.expectedDraftRevision !== currentBinding.expectedDraftRevision
      ) {
        return Promise.reject(new Error('STALE_DRAFT_BINDING'));
      }
      if (preparedBinding === undefined) {
        preparedBinding = currentBinding;
      } else if (
        input.draftRevisionId !== preparedBinding.draftRevisionId ||
        input.expectedDraftRevision !== preparedBinding.expectedDraftRevision
      ) {
        return Promise.reject(new Error('STALE_APPROVED_BINDING'));
      }
      return Promise.resolve({
        ...approvalResult,
        status: approvalPersisted ? 'approved' : 'pending_approval',
        updatedAt: approvalPersisted ? approvedAt : pendingAt,
      });
    },
  );
  apiClientMock.approvals.status.query.mockImplementation(
    (input: { readonly proposalId: string }) => {
      if (input.proposalId !== proposalId || preparedBinding === undefined) {
        return Promise.reject(new Error('PROPOSAL_NOT_FOUND'));
      }
      return Promise.resolve({
        proposalId,
        status: approvalPersisted ? 'approved' : 'pending_approval',
        updatedAt: approvalPersisted ? approvedAt : pendingAt,
      });
    },
  );
  apiClientMock.execution.status.query.mockImplementation(
    (input: { readonly proposalId: string }) => {
      if (input.proposalId !== proposalId || preparedBinding === undefined) {
        return Promise.reject(new Error('PROPOSAL_NOT_FOUND'));
      }
      return Promise.resolve(
        approvalPersisted
          ? {
              proposalId,
              storageMode: 'durable',
              effectPolicy: 'effect_disabled',
              externalEffect: false,
              status: 'effect_disabled',
              receipt: durableReceipt,
            }
          : {
              proposalId,
              status: 'pending_approval',
            },
      );
    },
  );
  apiClientMock.approvals.approve.mutate.mockImplementation(
    (input: {
      readonly proposalId: string;
      readonly expectedProposalUpdatedAt: string;
    }) => {
      if (
        preparedBinding === undefined ||
        approvalPersisted ||
        input.proposalId !== proposalId ||
        input.expectedProposalUpdatedAt !== pendingAt
      ) {
        return Promise.reject(new Error('STALE_PROPOSAL_BINDING'));
      }
      approvalPersisted = true;
      return Promise.resolve({
        proposalId,
        actionPlanId: approvalResult.actionPlanId,
        actionPlanRevision: approvalResult.actionPlanRevision,
        actionPlanHash: approvalResult.actionPlanHash,
        approvalId: 'approval-durable-1',
        operationId: 'operation-durable-1',
        status: 'approved',
        effectPolicy: 'effect_disabled',
        externalEffect: false,
        updatedAt: approvedAt,
        receipt: durableReceipt,
      });
    },
  );
  browserApiMock.getApprovalStatus.mockImplementation((inputId: string) => {
    if (inputId !== proposalId || preparedBinding === undefined) {
      return Promise.reject(new Error('PROPOSAL_NOT_FOUND'));
    }
    return Promise.resolve({
      proposalId,
      status: approvalPersisted ? 'approved' : 'pending_approval',
      updatedAt: approvalPersisted ? approvedAt : pendingAt,
    });
  });
  browserApiMock.getExecutionStatus.mockImplementation((inputId: string) => {
    if (inputId !== proposalId || preparedBinding === undefined) {
      return Promise.reject(new Error('PROPOSAL_NOT_FOUND'));
    }
    return Promise.resolve(
      approvalPersisted
        ? {
            proposalId,
            runtimeMode: 'fixture',
            effectPolicy: 'effect_disabled',
            externalEffect: false,
            status: 'effect_disabled',
            receipt: durableReceipt,
          }
        : {
            proposalId,
            runtimeMode: 'fixture',
            effectPolicy: 'effect_disabled',
            externalEffect: false,
            status: 'pending_approval',
          },
    );
  });
}

describe('executive evaluator application', () => {
  it('tries the typed same-origin API before entering a truthful local fallback', async () => {
    renderRoute('/overview');

    expect(await screen.findByText('Local fallback fixture.')).toBeTruthy();
    expect(screen.getByText('Good morning, Alex.')).toBeTruthy();
    expect(screen.getByTestId('metric-volume').textContent).toContain('5');
    expect(createBrowserApiMock).toHaveBeenCalledWith(window.location.origin);
  });

  it('shows secure sign-in for 401 and never substitutes fixture data', async () => {
    const unauthorized = new Error('BROWSER_AUTHENTICATION_REQUIRED');
    unauthorized.name = 'BrowserAuthenticationRequiredError';
    browserApiMock.systemHealth.mockRejectedValue(unauthorized);

    renderRoute('/inbox/thread-q3-launch');

    expect(
      await screen.findByRole('heading', { name: 'Sign in to Chief' }),
    ).toBeTruthy();
    expect(screen.queryByText('Local fallback fixture.')).toBeNull();
    expect(screen.queryByText('Taylor Reed')).toBeNull();
    expect(
      screen
        .getByRole('link', { name: 'Sign in securely' })
        .getAttribute('href'),
    ).toBe('/auth/login?returnTo=%2Finbox%2Fthread-q3-launch');
  });

  it('waits for concurrent bootstrap results and prioritizes a later 401 over an earlier network failure', async () => {
    let rejectMetrics!: (reason: unknown) => void;
    browserApiMock.dashboardMetrics.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectMetrics = reject;
        }),
    );
    browserApiMock.listCommunications.mockResolvedValue({
      items: [],
      nextCursor: undefined,
    });
    browserApiMock.getConnectorStatus.mockResolvedValue([]);

    renderRoute('/overview');

    await waitFor(() => {
      expect(browserApiMock.systemHealth).toHaveBeenCalledTimes(1);
      expect(browserApiMock.dashboardMetrics).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText('Local fallback fixture.')).toBeNull();

    const unauthorized = new Error('BROWSER_AUTHENTICATION_REQUIRED');
    unauthorized.name = 'BrowserAuthenticationRequiredError';
    act(() => {
      rejectMetrics(unauthorized);
    });

    expect(
      await screen.findByRole('heading', { name: 'Sign in to Chief' }),
    ).toBeTruthy();
    expect(screen.queryByText('Local fallback fixture.')).toBeNull();
    expect(screen.queryByText('Taylor Reed')).toBeNull();
  });

  it('posts same-origin logout and returns to the sign-in state', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    arrangeHostedProjection();
    renderRoute('/overview');

    await screen.findByText('Durable hosted evaluator data.');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(
      await screen.findByRole('heading', { name: 'Sign in to Chief' }),
    ).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledWith('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    fetchSpy.mockRestore();
  });

  it('renders typed durable hosted projections when the product API is available', async () => {
    arrangeHostedProjection();
    renderRoute('/overview');

    expect(
      await screen.findByText('Durable hosted evaluator data.'),
    ).toBeTruthy();
    expect(screen.getByTestId('metric-volume').textContent).toContain('1,120');
    expect(screen.getByTestId('metric-pending').textContent).toContain(
      '0 awaiting approval',
    );
    expect(screen.getByTestId('nav-pending-approval-count').textContent).toBe(
      '0',
    );
    expect(screen.getByRole('link', { name: 'View all 1,120' })).toBeTruthy();
    expect(
      screen
        .getByText('Friday launch decision')
        .closest('a')
        ?.getAttribute('href'),
    ).toBe('/inbox/thread-q3-launch');
    expect(screen.queryByText('Taylor Reed')).toBeNull();
  });

  it('labels the hosted multichannel corpus and static activity truthfully', async () => {
    arrangeHostedProjection();
    renderRoute('/overview');

    expect(
      await screen.findByText('Durable hosted evaluator data.'),
    ).toBeTruthy();
    expect(screen.getByTestId('activity-source-label').textContent).toContain(
      'Demonstration only',
    );
    expect(screen.getByTestId('activity-source-label').textContent).toContain(
      'hosted multichannel corpus',
    );

    cleanup();
    renderRoute('/inbox');
    expect(
      await screen.findByText('Server-authoritative multichannel corpus'),
    ).toBeTruthy();
    expect(
      screen.getByText(/complete deterministic 1,120-message corpus/i),
    ).toBeTruthy();
    expect(await screen.findByText(/showing 2 of 1,120/i)).toBeTruthy();
    expect(screen.getByText('Gmail')).toBeTruthy();
    expect(
      screen.getByText(/account-gmail-fixture · brand-northstar/i),
    ).toBeTruthy();

    cleanup();
    renderRoute('/evidence');
    expect(
      await screen.findByText(/1,120-message corpus across seven hosted/i),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /inspect the six fixture cards and one recorded LinkedIn archive card/i,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/demonstration-only/i)).toBeTruthy();
  });

  it('uses server-side channel and query filters with authoritative totals', async () => {
    const user = userEvent.setup();
    arrangeHostedProjection();
    renderRoute('/inbox');

    expect(
      await screen.findByText(/showing 2 of 1,120 matching communications/i),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load 100 more' })).toBeTruthy();
    await user.selectOptions(
      screen.getByTestId('inbox-channel-filter'),
      'microsoft_graph',
    );
    await user.type(screen.getByLabelText('Search communications'), 'board');

    await waitFor(() => {
      expect(browserApiMock.listCommunications).toHaveBeenCalledWith({
        limit: 100,
        query: 'board',
        channel: 'microsoft_graph',
      });
    });
  });

  it('discards a stale pagination response across an A-B-A server filter cycle', async () => {
    const user = userEvent.setup();
    arrangeHostedProjection();
    renderRoute('/inbox');

    expect(
      await screen.findByText(/showing 2 of 1,120 matching communications/i),
    ).toBeTruthy();

    type PageResult = Readonly<{
      items: readonly CommunicationSummaryView[];
      totalCount: number;
      nextCursor?: string;
    }>;
    let resolveStalePage!: (value: PageResult) => void;
    const stalePage = new Promise<PageResult>((resolve) => {
      resolveStalePage = resolve;
    });
    browserApiMock.listCommunications
      .mockImplementationOnce(() => stalePage)
      .mockResolvedValueOnce({
        items: [
          communicationSummaryViewSchema.parse({
            messageId: 'message-filtered',
            messageRevisionId: 'message-revision-filtered-1',
            revision: 1,
            threadId: 'thread-filtered',
            direction: 'inbound',
            status: 'pending',
            channel: 'microsoft_graph',
            accountId: 'account-graph-fixture',
            brandId: 'brand-harbor',
            senderDisplayName: 'Priya Shah',
            recipientDisplayNames: ['Avery Morgan'],
            subject: 'Filtered board update',
            excerpt: 'Only the filtered Graph result should remain visible.',
            attachmentCount: 0,
            sourceTimestamp: '2026-07-17T11:07:00.000Z',
            productUrl:
              'https://chief.example/communications/message-revision-filtered-1',
          }),
        ],
        totalCount: 1,
      });

    await user.click(screen.getByRole('button', { name: 'Load 100 more' }));
    await user.selectOptions(
      screen.getByTestId('inbox-channel-filter'),
      'microsoft_graph',
    );

    expect(
      await screen.findByText(/showing 1 of 1 matching communications/i),
    ).toBeTruthy();
    expect(screen.getByText('Filtered board update')).toBeTruthy();

    await user.selectOptions(screen.getByTestId('inbox-channel-filter'), 'all');
    expect(
      await screen.findByText(/showing 2 of 1,120 matching communications/i),
    ).toBeTruthy();

    resolveStalePage({
      items: [
        communicationSummaryViewSchema.parse({
          messageId: 'message-stale-page',
          messageRevisionId: 'message-revision-stale-page-1',
          revision: 1,
          threadId: 'thread-stale-page',
          direction: 'inbound',
          status: 'pending',
          channel: 'gmail',
          accountId: 'account-gmail-fixture',
          brandId: 'brand-northstar',
          senderDisplayName: 'Stale Sender',
          recipientDisplayNames: ['Avery Morgan'],
          subject: 'Stale unfiltered page',
          excerpt: 'This response completed after the filter changed.',
          attachmentCount: 0,
          sourceTimestamp: '2026-07-17T11:08:00.000Z',
          productUrl:
            'https://chief.example/communications/message-revision-stale-page-1',
        }),
      ],
      totalCount: 1_120,
      nextCursor: 'stale-page-3',
    });

    await waitFor(() => {
      expect(screen.queryByText('Stale unfiltered page')).toBeNull();
      expect(
        screen.getByText(/showing 2 of 1,120 matching communications/i),
      ).toBeTruthy();
      expect(
        screen.getByRole('button', { name: 'Load 100 more' }),
      ).toBeTruthy();
    });
  });

  it('enumerates exact server recommendations for actionable threads', async () => {
    arrangeHostedProjection();
    browserApiMock.listCommunications.mockImplementation(
      (input: { readonly status?: string }) => {
        if (input.status === 'pending') {
          return Promise.resolve({
            items: [hostedCommunicationItems[1]],
            totalCount: 1,
          });
        }
        if (input.status === 'overdue') {
          return Promise.resolve({
            items: [hostedCommunicationItems[0]],
            totalCount: 1,
          });
        }
        return Promise.resolve({
          items: hostedCommunicationItems,
          totalCount: 1_120,
          nextCursor: 'page-2',
        });
      },
    );
    browserApiMock.recommendAction.mockImplementation(
      (messageRevisionId: string) =>
        Promise.resolve({
          recommendationId: `recommendation-${messageRevisionId}`,
          sourceMessageRevisionId: messageRevisionId,
          revision: 1,
          actionType:
            messageRevisionId === 'message-revision-1-1'
              ? 'reply'
              : 'request_context',
          confidence: 0.88,
          urgency:
            messageRevisionId === 'message-revision-1-1' ? 'high' : 'normal',
          reasonSummary:
            messageRevisionId === 'message-revision-1-1'
              ? 'Reply with the cited launch owner and checkpoint.'
              : 'Request the approved pipeline source before replying.',
          citations: [{ citationId: 'citation-server-1' }],
          missingFacts:
            messageRevisionId === 'message-revision-1-1'
              ? []
              : ['Approved pipeline source'],
        }),
    );

    renderRoute('/recommended');

    expect(await screen.findAllByTestId('recommended-action-row')).toHaveLength(
      2,
    );
    expect(screen.getByTestId('recommendation-scope').textContent).toContain(
      '2 server recommendations from 2 unique actionable threads',
    );
    expect(screen.getByText('Friday launch decision')).toBeTruthy();
    expect(screen.getByText('Board update numbers')).toBeTruthy();
    expect(screen.getByText(/fixture\/effect-disabled runtime/i)).toBeTruthy();
    expect(browserApiMock.recommendAction).toHaveBeenCalledWith(
      'message-revision-1-1',
      1,
    );
    expect(browserApiMock.recommendAction).toHaveBeenCalledWith(
      'message-revision-2-1',
      1,
    );
    expect(screen.queryByText('Taylor Reed')).toBeNull();
  });

  it('caps the recommendation fan-out and discloses the uninspected threads', async () => {
    arrangeHostedProjection();
    const corpus = buildActionableCorpus(40);
    arrangeActionableCorpus(corpus);
    browserApiMock.recommendAction.mockImplementation(
      (messageRevisionId: string) =>
        Promise.resolve(buildCorpusRecommendation(messageRevisionId)),
    );

    renderRoute('/recommended');

    expect(await screen.findAllByTestId('recommended-action-row')).toHaveLength(
      12,
    );
    await waitFor(() => {
      expect(screen.queryByTestId('recommendation-progress')).toBeNull();
    });
    expect(browserApiMock.recommendAction).toHaveBeenCalledTimes(12);
    const scope = screen.getByTestId('recommendation-scope').textContent ?? '';
    expect(scope).toContain(
      'Showing 12 server recommendations from the newest 12 of 40 unique actionable threads',
    );
    expect(scope).toContain('The remaining 28 actionable threads');
    expect(scope).toContain('claims nothing about them');
    // The newest twelve threads are inspected; the rest are never requested.
    expect(browserApiMock.recommendAction).toHaveBeenCalledWith(
      'corpus-message-revision-00',
      1,
    );
    expect(browserApiMock.recommendAction).toHaveBeenCalledWith(
      'corpus-message-revision-11',
      1,
    );
    expect(browserApiMock.recommendAction).not.toHaveBeenCalledWith(
      'corpus-message-revision-12',
      1,
    );
    expect(screen.getByText('Corpus actionable thread 00')).toBeTruthy();
    expect(screen.queryByText('Corpus actionable thread 12')).toBeNull();
  });

  it('renders each recommendation as it arrives instead of one terminal update', async () => {
    arrangeHostedProjection();
    const corpus = buildActionableCorpus(40);
    arrangeActionableCorpus(corpus);
    const pending = new Map<string, (value: unknown) => void>();
    browserApiMock.recommendAction.mockImplementation(
      (messageRevisionId: string) =>
        new Promise((resolve) => {
          pending.set(messageRevisionId, resolve);
        }),
    );

    renderRoute('/recommended');

    await waitFor(() => {
      expect(pending.size).toBe(6);
    });
    expect(screen.getByTestId('recommendation-progress').textContent).toContain(
      'Inspected 0 of 12 threads so far',
    );
    expect(screen.queryAllByTestId('recommended-action-row')).toHaveLength(0);

    await act(async () => {
      pending.get('corpus-message-revision-03')?.(
        buildCorpusRecommendation('corpus-message-revision-03'),
      );
      await Promise.resolve();
    });

    // One settled response renders immediately while eleven are outstanding.
    expect(await screen.findAllByTestId('recommended-action-row')).toHaveLength(
      1,
    );
    expect(screen.getByText('Corpus actionable thread 03')).toBeTruthy();
    expect(screen.getByTestId('recommendation-progress').textContent).toContain(
      'Still reading: 1 of 12 inspected threads have returned',
    );

    for (let round = 0; round < 20 && pending.size > 0; round += 1) {
      // Drains one concurrency wave at a time.
      await act(async () => {
        for (const [messageRevisionId, resolve] of [...pending]) {
          pending.delete(messageRevisionId);
          resolve(buildCorpusRecommendation(messageRevisionId));
        }
        await Promise.resolve();
      });
    }
    await waitFor(() => {
      expect(screen.queryByTestId('recommendation-progress')).toBeNull();
    });
    expect(screen.getAllByTestId('recommended-action-row')).toHaveLength(12);
    // Newest-first order survives the out-of-order incremental arrival.
    expect(
      screen
        .getAllByTestId('recommended-action-row')
        .map((row) => row.querySelector('strong')?.textContent),
    ).toEqual(
      Array.from(
        { length: 12 },
        (_, index) =>
          `Corpus actionable thread ${String(index).padStart(2, '0')}`,
      ),
    );
  });

  it('shows no fabricated approval cards when no exact proposal ID is known', async () => {
    arrangeHostedProjection();
    renderRoute('/approvals');

    expect(
      (await screen.findByTestId('approval-pending-count')).textContent,
    ).toContain('0 pending server-wide');
    expect(screen.getByTestId('nav-pending-approval-count').textContent).toBe(
      '0',
    );
    expect(
      await screen.findByRole('heading', {
        name: 'No verified proposal is known in this tab',
      }),
    ).toBeTruthy();
    expect(screen.getByText(/no list-proposals endpoint/i)).toBeTruthy();
    expect(screen.queryByText('Reply to Taylor Reed')).toBeNull();
    expect(screen.queryByText('Update board packet task')).toBeNull();
    expect(browserApiMock.getApprovalStatus).not.toHaveBeenCalled();
  });

  it('enumerates a real prepared proposal and rechecks server status', async () => {
    arrangeHostedThread();
    const user = userEvent.setup();
    renderRoute('/inbox/thread-q3-launch');

    await screen.findByTestId<HTMLTextAreaElement>('draft-editor');
    await user.click(
      screen.getByRole('button', { name: 'Create concise revision' }),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId('approve-action').hasAttribute('disabled'),
      ).toBe(false);
    });
    const approvalsLink = screen
      .getAllByRole('link', { name: /^Approvals/ })
      .find((link) => link.getAttribute('href') === '/approvals');
    expect(approvalsLink).toBeDefined();
    await user.click(approvalsLink!);

    const row = await screen.findByTestId('approval-queue-row');
    expect(row.textContent).toContain('proposal-durable-1');
    expect(row.textContent).toContain('Friday launch decision');
    expect(row.textContent).toContain('pending approval');
    expect(row.textContent).toContain('external effects disabled');
    expect(browserApiMock.getApprovalStatus).toHaveBeenCalledWith(
      'proposal-durable-1',
    );
    expect(browserApiMock.getExecutionStatus).toHaveBeenCalledWith(
      'proposal-durable-1',
    );
    expect(screen.queryByText(/demonstration only/i)).toBeNull();
  });

  it('loads an exact pending proposal through the read-only durable route', async () => {
    apiClientMock.approvals.status.query.mockResolvedValue({
      proposalId: 'proposal-route-1',
      status: 'pending_approval',
      approvalUrl: 'https://chief.example/approvals/proposal-route-1',
      updatedAt: '2026-07-17T12:01:00.000Z',
    });
    apiClientMock.execution.status.query.mockResolvedValue({
      proposalId: 'proposal-route-1',
      runtimeMode: 'fixture',
      storageMode: 'durable',
      effectPolicy: 'effect_disabled',
      externalEffect: false,
      status: 'pending_approval',
    });

    renderRoute('/approvals/proposal-route-1');

    expect(
      await screen.findByRole('heading', { name: 'Approval is pending' }),
    ).toBeTruthy();
    expect(screen.getByTestId('approval-route-status').textContent).toContain(
      'proposal-route-1',
    );
    expect(screen.getByTestId('approval-route-pending').textContent).toContain(
      'No provider request or external effect has occurred',
    );
    expect(apiClientMock.approvals.status.query).toHaveBeenCalledWith({
      proposalId: 'proposal-route-1',
    });
    expect(apiClientMock.execution.status.query).toHaveBeenCalledWith({
      proposalId: 'proposal-route-1',
    });
    expect(
      screen.queryByRole('button', { name: /approve|send|dispatch/i }),
    ).toBeNull();
  });

  it('renders the approved proposal only with its durable effect-disabled receipt', async () => {
    apiClientMock.approvals.status.query.mockResolvedValue({
      proposalId: 'proposal-route-approved',
      status: 'approved',
      approvalUrl: 'https://chief.example/approvals/proposal-route-approved',
      updatedAt: '2026-07-17T12:02:00.000Z',
    });
    apiClientMock.execution.status.query.mockResolvedValue({
      proposalId: 'proposal-route-approved',
      runtimeMode: 'fixture',
      storageMode: 'durable',
      effectPolicy: 'effect_disabled',
      externalEffect: false,
      status: 'effect_disabled',
      receipt: {
        kind: 'effect_disabled',
        operationId: 'operation-route-approved',
        artifactHash: 'c'.repeat(64),
        stableIdempotencyKey: 'route-approved-once',
        observedAt: '2026-07-17T12:02:00.000Z',
      },
    });

    renderRoute('/approvals/proposal-route-approved');

    expect(
      await screen.findByRole('heading', {
        name: 'Approval completed safely',
      }),
    ).toBeTruthy();
    expect(screen.getByTestId('execution-receipt').textContent).toContain(
      'operation-route-approved',
    );
    expect(screen.getByTestId('execution-receipt').textContent).toContain(
      'Durable effect-disabled receipt',
    );
    expect(
      screen.queryByRole('button', { name: /approve|send|dispatch/i }),
    ).toBeNull();
  });

  it('shows bounded loading, not-found, and safe error proposal states', async () => {
    apiClientMock.approvals.status.query.mockImplementation(
      () => new Promise(() => undefined),
    );
    apiClientMock.execution.status.query.mockImplementation(
      () => new Promise(() => undefined),
    );
    renderRoute('/approvals/proposal-loading');
    expect(await screen.findByTestId('approval-route-loading')).toBeTruthy();

    cleanup();
    apiClientMock.approvals.status.query.mockRejectedValue(
      Object.assign(new Error('Proposal was not found.'), {
        data: { code: 'NOT_FOUND' },
      }),
    );
    apiClientMock.execution.status.query.mockResolvedValue({});
    renderRoute('/approvals/proposal-missing');
    expect(await screen.findByTestId('approval-route-not-found')).toBeTruthy();

    cleanup();
    apiClientMock.approvals.status.query.mockRejectedValue(
      new Error('temporary read failure'),
    );
    renderRoute('/approvals/proposal-error');
    expect(await screen.findByTestId('approval-route-error')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(
      'No action was taken',
    );

    cleanup();
    renderRoute(`/approvals/${'x'.repeat(161)}`);
    expect(await screen.findByTestId('approval-route-not-found')).toBeTruthy();
    expect(apiClientMock.approvals.status.query).toHaveBeenCalledTimes(3);
  });

  it('distinguishes six hosted fixture cards from one recorded card', async () => {
    arrangeHostedProjection();
    renderRoute('/connections');

    expect(await screen.findAllByTestId('connector-card')).toHaveLength(7);
    expect(
      screen.getByText(
        /seven account-scoped connector cards.*six fixture-mode cards and one manual\/recorded LinkedIn archive card/i,
      ),
    ).toBeTruthy();
    expect(screen.getByText('Source-owned cards')).toBeTruthy();
    expect(screen.getByText('Six fixture · one recorded')).toBeTruthy();
    expect(screen.getByTestId('hosted-seed-fixture-count').textContent).toBe(
      '7 hosted connector cards',
    );
    expect(screen.getByTestId('hosted-seed-recorded-count').textContent).toBe(
      '1 hosted evidence card',
    );
    expect(screen.getByTestId('hosted-seed-blocked-count').textContent).toBe(
      '0 hosted connector cards',
    );
    expect(screen.getByTestId('connection-count-recorded').textContent).toBe(
      '1 hosted evidence cards',
    );
    expect(screen.getByTestId('connection-count-fixture').textContent).toBe(
      '6 hosted fixture connector cards',
    );
    expect(
      screen.getByTestId('capability-mode-linkedin_archive').textContent,
    ).toContain('Recorded evidence');
    expect(screen.getByTestId('connection-count-blocked').textContent).toBe(
      '0 hosted blocked cards',
    );
  });

  it('filters the local fallback inbox with an accessible native select', async () => {
    const user = userEvent.setup();
    renderRoute('/inbox');

    const filter = await screen.findByLabelText('Status');
    await user.selectOptions(filter, 'answered');

    expect(screen.getByText('Re: enterprise pricing exception')).toBeTruthy();
    expect(
      screen.queryByText('Decision needed: Q3 launch risk and customer note'),
    ).toBeNull();
  });

  it('never substitutes the Taylor thread for another fallback route', async () => {
    renderRoute('/inbox/thread-board-packet');

    expect(
      await screen.findByText('Board packet — final operating metrics'),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Maya Chen' })).toBeTruthy();
    expect(screen.getByTestId('thread-detail').textContent).toContain(
      'No other communication is substituted',
    );
    expect(screen.queryByText('Taylor Reed')).toBeNull();
  });

  it('resolves API communication deep links into the exact existing thread UI', async () => {
    arrangeHostedThread();
    renderRoute('/communications/message-revision-1-1');

    expect(
      await screen.findByRole('heading', { name: 'Friday launch decision' }),
    ).toBeTruthy();
    expect(screen.getByTestId('thread-detail')).toBeTruthy();
    expect(
      screen.queryByRole('heading', {
        name: 'This communication view does not exist.',
      }),
    ).toBeNull();
  });

  it('resolves API thread deep links into the existing thread UI', async () => {
    arrangeHostedThread();
    renderRoute('/threads/thread-1');

    expect(
      await screen.findByRole('heading', { name: 'Friday launch decision' }),
    ).toBeTruthy();
    expect(screen.getByTestId('thread-detail')).toBeTruthy();
  });

  it('routes attachment deep links to the bounded existing inbox UI', async () => {
    arrangeHostedProjection();
    renderRoute('/attachments/attachment-launch-readiness');

    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeTruthy();
    expect(
      screen.queryByRole('heading', {
        name: 'This communication view does not exist.',
      }),
    ).toBeNull();
  });

  it('routes connector settings deep links to the existing connections UI', async () => {
    arrangeHostedProjection();
    renderRoute('/settings/connectors/gmail');

    expect(
      await screen.findByRole('heading', { name: 'Connections' }),
    ).toBeTruthy();
    expect(await screen.findAllByTestId('connector-card')).toHaveLength(7);
  });

  it('never grants approval authority to the local fallback', async () => {
    const user = userEvent.setup();
    renderRoute('/inbox/thread-q3-launch');

    expect(
      await screen.findByText('DEMO-4821 · Synthetic pilot review fixture'),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('SEC-4821');
    expect(document.body.textContent).not.toContain('Asana ·');

    const approve = await screen.findByRole('button', {
      name: 'Hosted durable approval required',
    });
    expect(approve.hasAttribute('disabled')).toBe(true);

    const draft =
      await screen.findByTestId<HTMLTextAreaElement>('draft-editor');
    const original = draft.value;
    expect(draft.hasAttribute('readonly')).toBe(true);

    await user.click(
      screen.getByRole('button', { name: 'Create concise revision' }),
    );
    expect(screen.getByTestId('revision-diff')).toBeTruthy();
    expect(draft.value).not.toBe(original);
    expect(draft.value.length).toBeLessThan(original.length);
    expect(approve.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByTestId('execution-receipt')).toBeNull();
    expect(
      screen.getByText(/not persisted and cannot be approved/i),
    ).toBeTruthy();
  });

  it('persists the exact hosted revision through server-authorized approval', async () => {
    arrangeHostedThread();
    const user = userEvent.setup();
    renderRoute('/inbox/thread-q3-launch');

    const editor =
      await screen.findByTestId<HTMLTextAreaElement>('draft-editor');
    const originalDraft = editor.value;
    expect(editor.hasAttribute('readonly')).toBe(true);
    expect(screen.getByText(/persisted body is read-only/i)).toBeTruthy();
    expect(screen.getByTestId('approve-action').hasAttribute('disabled')).toBe(
      true,
    );

    await user.click(
      screen.getByRole('button', { name: 'Create concise revision' }),
    );
    expect(browserApiMock.reviseDraft).toHaveBeenCalledWith({
      draftRevisionId: 'draft-revision-1',
      expectedDraftRevision: 1,
      revisionInstruction:
        'Make this draft concise while retaining all cited facts.',
    });
    await waitFor(() => {
      expect(apiClientMock.approvals.prepareDraft.mutate).toHaveBeenCalledWith({
        draftRevisionId: 'draft-revision-2',
        expectedDraftRevision: 2,
      });
    });
    expect(editor.value).not.toBe(originalDraft);
    expect(editor.value.length).toBeLessThan(originalDraft.length);
    expect(screen.getByTestId('revision-diff').textContent).toContain(
      'Make this draft concise while retaining all cited facts.',
    );
    await waitFor(() => {
      expect(
        screen.getByTestId('approve-action').hasAttribute('disabled'),
      ).toBe(false);
    });
    await user.click(screen.getByTestId('approve-action'));

    expect(
      await screen.findByText('Durable effect-disabled receipt', {
        exact: false,
      }),
    ).toBeTruthy();
    expect(apiClientMock.approvals.approve.mutate).toHaveBeenCalledWith({
      proposalId: 'proposal-durable-1',
      expectedProposalUpdatedAt: '2026-07-17T12:01:00.000Z',
    });
    expect(screen.getByTestId('execution-receipt').textContent).toContain(
      'operation-durable-1',
    );

    cleanup();
    renderRoute('/inbox/thread-q3-launch');

    expect(
      await screen.findByText('Durable hosted draft revision 2'),
    ).toBeTruthy();
    expect(
      await screen.findByText('Durable effect-disabled receipt', {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.getByTestId('execution-receipt').textContent).toContain(
      'operation-durable-1',
    );
    expect(browserApiMock.createDraft).toHaveBeenCalledTimes(2);
    expect(apiClientMock.approvals.prepareDraft.mutate).toHaveBeenNthCalledWith(
      2,
      {
        draftRevisionId: 'draft-revision-2',
        expectedDraftRevision: 2,
      },
    );
    expect(apiClientMock.approvals.approve.mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId<HTMLTextAreaElement>('draft-editor').value).toBe(
      'Confirm the owner and review at 16:00 UTC.',
    );
  });

  it('recovers a committed effect-disabled receipt after approval acknowledgement failure', async () => {
    arrangeHostedThread();
    const user = userEvent.setup();
    renderRoute('/inbox/thread-q3-launch');

    await screen.findByTestId<HTMLTextAreaElement>('draft-editor');
    await user.click(
      screen.getByRole('button', { name: 'Create concise revision' }),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId('approve-action').hasAttribute('disabled'),
      ).toBe(false);
    });

    apiClientMock.approvals.approve.mutate.mockRejectedValue(
      new Error('SQS_UNAVAILABLE'),
    );
    apiClientMock.approvals.status.query.mockResolvedValue({
      proposalId: 'proposal-durable-1',
      status: 'approved',
      updatedAt: '2026-07-17T12:02:00.000Z',
    });
    apiClientMock.execution.status.query.mockResolvedValue({
      proposalId: 'proposal-durable-1',
      runtimeMode: 'fixture',
      storageMode: 'durable',
      effectPolicy: 'effect_disabled',
      externalEffect: false,
      status: 'effect_disabled',
      receipt: {
        kind: 'effect_disabled',
        operationId: 'operation-durable-recovered',
        artifactHash: 'd'.repeat(64),
        stableIdempotencyKey: 'durable-recovered-once',
        observedAt: '2026-07-17T12:02:00.000Z',
      },
    });

    await user.click(screen.getByTestId('approve-action'));

    expect(await screen.findByTestId('approval-recovered')).toBeTruthy();
    expect(screen.getByTestId('approval-recovered').textContent).toContain(
      'effect-disabled receipt were recovered',
    );
    expect(screen.getByTestId('execution-receipt').textContent).toContain(
      'operation-durable-recovered',
    );
    expect(screen.queryByText(/approval was not persisted/i)).toBeNull();
    expect(apiClientMock.approvals.status.query).toHaveBeenLastCalledWith({
      proposalId: 'proposal-durable-1',
    });
    expect(apiClientMock.execution.status.query).toHaveBeenLastCalledWith({
      proposalId: 'proposal-durable-1',
    });
  });

  it('keeps a reconciled pending proposal pending after acknowledgement failure', async () => {
    arrangeHostedThread();
    const user = userEvent.setup();
    renderRoute('/inbox/thread-q3-launch');

    await screen.findByTestId<HTMLTextAreaElement>('draft-editor');
    await user.click(
      screen.getByRole('button', { name: 'Create concise revision' }),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId('approve-action').hasAttribute('disabled'),
      ).toBe(false);
    });
    apiClientMock.approvals.approve.mutate.mockRejectedValue(
      new Error('SQS_UNAVAILABLE'),
    );
    apiClientMock.approvals.status.query.mockResolvedValue({
      proposalId: 'proposal-durable-1',
      status: 'pending_approval',
      updatedAt: '2026-07-17T12:01:00.000Z',
    });
    apiClientMock.execution.status.query.mockResolvedValue({
      proposalId: 'proposal-durable-1',
      runtimeMode: 'fixture',
      storageMode: 'durable',
      effectPolicy: 'effect_disabled',
      externalEffect: false,
      status: 'pending_approval',
    });

    await user.click(screen.getByTestId('approve-action'));

    const notice = await screen.findByTestId('approval-reconciliation-pending');
    expect(notice.textContent).toContain('durable status remains pending');
    expect(notice.textContent).toContain('No external effect');
    expect(screen.queryByTestId('execution-receipt')).toBeNull();
    expect(screen.getByTestId('approve-action').hasAttribute('disabled')).toBe(
      false,
    );
    expect(screen.queryByText(/approval was not persisted/i)).toBeNull();
  });

  it('reports uncertain durable status without claiming non-persistence', async () => {
    arrangeHostedThread();
    const user = userEvent.setup();
    renderRoute('/inbox/thread-q3-launch');

    await screen.findByTestId<HTMLTextAreaElement>('draft-editor');
    await user.click(
      screen.getByRole('button', { name: 'Create concise revision' }),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId('approve-action').hasAttribute('disabled'),
      ).toBe(false);
    });
    apiClientMock.approvals.approve.mutate.mockRejectedValue(
      new Error('SQS_UNAVAILABLE'),
    );
    apiClientMock.approvals.status.query.mockRejectedValue(
      new Error('STATUS_UNAVAILABLE'),
    );
    apiClientMock.execution.status.query.mockRejectedValue(
      new Error('STATUS_UNAVAILABLE'),
    );

    await user.click(screen.getByTestId('approve-action'));

    const warning = await screen.findByTestId(
      'approval-reconciliation-uncertain',
    );
    expect(warning.textContent).toContain(
      'durable status could not be reconciled',
    );
    expect(warning.textContent).toContain('Reload this exact thread');
    expect(warning.textContent).toContain('External effects remain disabled');
    expect(warning.textContent).not.toContain('not persisted');
    expect(screen.queryByTestId('execution-receipt')).toBeNull();
  });

  it('provides visible, safe Cursor MCP instructions', async () => {
    renderRoute('/evidence');

    const instructions = await screen.findByTestId('mcp-instructions');
    expect(instructions.textContent).toContain('https://<hosted-api>/mcp');
    expect(instructions.textContent).toContain(
      'Approval stays in the product.',
    );
    expect(instructions.textContent).toContain(
      'Prepare and approve through the server-authorized product browser or API.',
    );
    expect(instructions.textContent).toContain(
      'short-lived bearer access token',
    );
    expect(instructions.textContent).toContain('opaque session cookie');
    expect(instructions.textContent).toContain('get_approval_status');
    expect(instructions.textContent).toContain(
      'external effects remain disabled',
    );
    expect(instructions.textContent).not.toContain('submit_for_approval');
    expect(instructions.textContent).not.toContain('bearer_example');
  });
});
