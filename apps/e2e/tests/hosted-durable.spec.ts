import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';

import { readRequiredHostedEnvironment } from '../hosted-environment.js';

const hosted = readRequiredHostedEnvironment();

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

async function responseJson(response: APIResponse): Promise<unknown> {
  const text = await response.text();
  const dataLine = text
    .split(/\r?\n/u)
    .find((line) => line.startsWith('data:'));
  return JSON.parse(dataLine?.slice('data:'.length).trim() ?? text) as unknown;
}

function unwrapTrpcResult(value: unknown): Record<string, unknown> {
  const envelope = (Array.isArray(value) ? value[0] : value) as {
    readonly result?: {
      readonly data?: unknown;
    };
    readonly error?: unknown;
  };
  expect(envelope.error, 'tRPC call must not return an error').toBeUndefined();
  const data = envelope.result?.data;
  const result =
    typeof data === 'object' && data !== null && 'json' in data
      ? (data as { readonly json: unknown }).json
      : data;
  expect(result).toBeDefined();
  return result as Record<string, unknown>;
}

async function trpcQuery(
  request: APIRequestContext,
  route: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const encoded = encodeURIComponent(JSON.stringify({ json: input }));
  const response = await request.get(
    `${hosted.apiBaseUrl}/trpc/${route}?input=${encoded}`,
  );
  expect(response.ok(), `${route} query should succeed`).toBe(true);
  return unwrapTrpcResult(await responseJson(response));
}

async function mcpRequest(
  request: APIRequestContext,
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const response = await request.post(`${hosted.mcpBaseUrl}/mcp`, {
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    data: {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    },
  });
  expect(response.ok(), `${method} should succeed`).toBe(true);
  return (await responseJson(response)) as JsonRpcResponse;
}

test.describe('non-skippable durable hosted composition', () => {
  test('persists revise, approval, outbox receipt and proves MCP protocol calls', async ({
    page,
    request,
  }) => {
    await page.goto('/inbox/thread-q3-launch');
    await expect(
      page.getByText('Durable hosted evaluator data.'),
    ).toBeVisible();
    await expect(page.getByText(/local fallback/i)).toHaveCount(0);

    const draft = page.getByTestId('draft-editor');
    await expect(draft).toHaveAttribute('readonly');
    const original = await draft.inputValue();
    await expect(page.getByText(/persisted body is read-only/i)).toBeVisible();
    await expect(page.getByTestId('approve-action')).toBeDisabled();

    await page.getByRole('button', { name: 'Create concise revision' }).click();
    await expect(page.getByTestId('revision-diff')).toBeVisible();
    const revised = await draft.inputValue();
    expect(revised).not.toBe(original);
    expect(revised.length).toBeLessThan(original.length);
    await expect(page.getByTestId('revision-diff')).toContainText(
      'Make this draft concise while retaining all cited facts.',
    );
    await expect(page.getByTestId('approve-action')).toBeEnabled();
    await page.getByTestId('approve-action').click();

    const receipt = page.getByTestId('execution-receipt');
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText(/durable effect-disabled receipt/i);
    const proposalId = (
      await receipt
        .locator('dt', { hasText: 'Proposal' })
        .locator('..')
        .locator('dd')
        .textContent()
    )?.trim();
    const operationId = (
      await receipt
        .locator('dt', { hasText: 'Operation' })
        .locator('..')
        .locator('dd')
        .textContent()
    )?.trim();
    expect(proposalId).toBeTruthy();
    expect(operationId).toBeTruthy();
    const persistedDraftBody = await draft.inputValue();
    const persistedRevisionLabel = await page
      .locator('label[for="hosted-draft-editor"]')
      .textContent();

    await page.reload();
    await expect(page.getByTestId('draft-editor')).toHaveValue(
      persistedDraftBody,
    );
    await expect(page.locator('label[for="hosted-draft-editor"]')).toHaveText(
      persistedRevisionLabel!,
    );
    await expect(page.getByTestId('execution-receipt')).toContainText(
      proposalId!,
    );
    await expect(page.getByTestId('execution-receipt')).toContainText(
      operationId!,
    );

    await page.goto(`/approvals/${proposalId}`);
    await expect(
      page.getByRole('heading', { name: 'Approval completed safely' }),
    ).toBeVisible();
    await expect(page.getByTestId('approval-route-status')).toContainText(
      proposalId!,
    );
    await expect(page.getByTestId('execution-receipt')).toContainText(
      operationId!,
    );
    await expect(
      page.getByRole('button', { name: /approve|send|dispatch/i }),
    ).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('execution-receipt')).toContainText(
      operationId!,
    );
    expect(new URL(page.url()).pathname).toBe(`/approvals/${proposalId}`);

    const approvalStatus = await trpcQuery(request, 'approvals.status', {
      proposalId,
    });
    expect(approvalStatus).toMatchObject({ proposalId, status: 'approved' });
    const executionStatus = await trpcQuery(request, 'execution.status', {
      proposalId,
    });
    expect(executionStatus).toMatchObject({
      proposalId,
      storageMode: 'durable',
      effectPolicy: 'effect_disabled',
      externalEffect: false,
      status: 'effect_disabled',
      receipt: { operationId },
    });

    const initialize = await mcpRequest(request, 1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'chief-hosted-acceptance', version: '1.0.0' },
    });
    expect(initialize.error).toBeUndefined();
    expect(initialize.result).toMatchObject({
      protocolVersion: '2025-06-18',
    });

    const tools = await mcpRequest(request, 2, 'tools/list');
    expect(tools.error).toBeUndefined();
    const toolNames = (
      (tools.result?.tools as readonly { readonly name: string }[]) ?? []
    ).map(({ name }) => name);
    expect(toolNames).toContain('list_pending_communications');
    expect(toolNames).toContain('get_approval_status');
    expect(toolNames).not.toContain('approve');
    expect(toolNames).not.toContain('send_message');

    const approvalToolCall = await mcpRequest(request, 3, 'tools/call', {
      name: 'get_approval_status',
      arguments: { proposalId },
    });
    expect(approvalToolCall.error).toBeUndefined();
    expect(approvalToolCall.result?.isError).not.toBe(true);
    expect(approvalToolCall.result?.structuredContent).toEqual(approvalStatus);
    expect(approvalToolCall.result?.structuredContent).toMatchObject({
      proposalId,
      status: 'approved',
    });
    expect(executionStatus).toMatchObject({
      proposalId,
      storageMode: 'durable',
      status: 'effect_disabled',
      receipt: { operationId },
    });
  });
});
