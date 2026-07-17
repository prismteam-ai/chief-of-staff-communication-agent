// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from './App.js';

const { browserApiMock, createBrowserApiMock } = vi.hoisted(() => {
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
  };
});

vi.mock('@chief/browser-api', () => ({
  createBrowserApi: createBrowserApiMock,
}));

beforeEach(() => {
  for (const method of Object.values(browserApiMock)) method.mockReset();
  browserApiMock.systemHealth.mockRejectedValue(
    new Error('hosted API unavailable'),
  );
  createBrowserApiMock.mockClear();
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

function arrangeHostedProjection() {
  browserApiMock.systemHealth.mockResolvedValue({
    service: 'chief-api',
    status: 'ok',
    timestamp: '2026-07-17T12:00:00.000Z',
    foundationOnly: false,
  });
  browserApiMock.dashboardMetrics.mockResolvedValue({
    totalCommunications: 1,
    pendingApprovalCount: 1,
    channelBreakdown: [{ channel: 'email', count: 1 }],
    snapshot: {
      schemaVersion: '1',
      window: '7d',
      measuredAt: '2026-07-17T12:00:00.000Z',
      pendingCount: 0,
      overdueCount: 1,
      answeredCount: 0,
      resolvedCount: 0,
      responseTimeP50Ms: 42_000,
      responseTimeP95Ms: 118_000,
    },
  });
  browserApiMock.listCommunications.mockResolvedValue({
    items: [
      {
        messageId: 'message-1',
        messageRevisionId: 'message-revision-1-1',
        revision: 1,
        threadId: 'thread-1',
        direction: 'inbound',
        status: 'overdue',
        senderDisplayName: 'Jordan Lee',
        recipientDisplayNames: ['Avery Morgan'],
        subject: 'Friday launch decision',
        excerpt: 'Can we confirm the Friday launch and the owner for QA?',
        attachmentCount: 1,
        sourceTimestamp: '2026-07-17T10:52:00.000Z',
        productUrl: 'https://chief.example/communications/message-revision-1-1',
      },
    ],
  });
  browserApiMock.getConnectorStatus.mockResolvedValue([]);
}

describe('executive evaluator application', () => {
  it('tries the typed same-origin API before entering a truthful local fallback', async () => {
    renderRoute('/overview');

    expect(await screen.findByText('Local fallback fixture.')).toBeTruthy();
    expect(screen.getByText('Good morning, Alex.')).toBeTruthy();
    expect(screen.getByTestId('metric-volume').textContent).toContain('5');
    expect(createBrowserApiMock).toHaveBeenCalledWith(window.location.origin);
  });

  it('renders typed hosted fixture projections when the product API is available', async () => {
    arrangeHostedProjection();
    renderRoute('/overview');

    expect(await screen.findByText('Hosted assessment fixture.')).toBeTruthy();
    expect(screen.getByTestId('metric-volume').textContent).toContain('1');
    expect(
      screen
        .getByText('Friday launch decision')
        .closest('a')
        ?.getAttribute('href'),
    ).toBe('/inbox/thread-q3-launch');
    expect(screen.queryByText('Taylor Reed')).toBeNull();
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

  it('requires a new immutable revision before explicit local approval', async () => {
    const user = userEvent.setup();
    renderRoute('/inbox/thread-q3-launch');

    const approve = await screen.findByRole('button', {
      name: 'Approve revision 2',
    });
    expect(approve.hasAttribute('disabled')).toBe(true);

    await user.click(
      screen.getByRole('button', { name: 'Revise for brevity' }),
    );
    expect(screen.getByTestId('revision-diff')).toBeTruthy();
    expect(approve.hasAttribute('disabled')).toBe(false);

    await user.click(approve);
    await waitFor(() => {
      expect(screen.getByTestId('execution-receipt')).toBeTruthy();
    });
    expect(screen.getByText('effect_disabled')).toBeTruthy();
    expect(screen.getByTestId('asana-status').textContent).toContain(
      'external task unchanged',
    );
  });

  it('provides visible, safe Cursor MCP instructions', () => {
    renderRoute('/evidence');

    const instructions = screen.getByTestId('mcp-instructions');
    expect(instructions.textContent).toContain('https://<hosted-api>/mcp');
    expect(instructions.textContent).toContain(
      'Approval stays in the product.',
    );
    expect(instructions.textContent).not.toContain('bearer_example');
  });
});
