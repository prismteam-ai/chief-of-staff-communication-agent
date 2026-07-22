import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import {
  createMemoryDurableApiDependencies,
  RequestAuthorityError,
  type ProductRequestContext,
  type ProductService,
} from '@chief/api';

import {
  deterministicEvaluatorIdentityV1,
  mcpCreateDraftResultSchema,
  mcpGetApprovalStatusResultSchema,
  mcpGetConnectorStatusResultSchema,
  mcpGetRelatedAsanaWorkResultSchema,
  mcpGetSlaMetricsResultSchema,
  mcpGetThreadContextResultSchema,
  mcpListPendingResultSchema,
  mcpRecommendActionResultSchema,
  mcpRequestContextResultSchema,
  mcpSearchKnowledgeResultSchema,
  mcpToolNameSchema,
  proposalHandoffSchema,
  serverRequestContextSchema,
} from '@chief/contracts';

import {
  configuredProductBaseUrl,
  FixtureMcpToolService,
  publicFixtureIdentifiers,
  publicFixtureScope,
} from './fixture-service.js';
import { createHandler } from './handler.js';
import {
  createMcpAdapterResolver,
  ProductServiceMcpAdapter,
} from './product-service-adapter.js';
import type { McpRequestScope, McpToolService } from './service.js';

const TEST_BEARER = 'test-header.test-payload.test-signature';
const testDependencies = createMemoryDurableApiDependencies({
  baseUrl: 'https://chief.example.test',
});
const testContext = testDependencies.requestContext;
const testScope: McpRequestScope = publicFixtureScope;

function authenticatedHandler(options: {
  readonly service: McpToolService;
  readonly scope?: McpRequestScope;
  readonly timeoutMs?: number;
  readonly healthCheck?: () => Promise<void>;
}) {
  return createHandler({
    adapterResolver: {
      resolve: ({ headers }) => {
        const authorization = Object.entries(headers).filter(
          ([name]) => name.toLowerCase() === 'authorization',
        );
        if (
          authorization.length !== 1 ||
          authorization[0]?.[1] !== `Bearer ${TEST_BEARER}`
        ) {
          throw new RequestAuthorityError(
            'unauthorized',
            authorization.length === 0
              ? 'authentication_required'
              : 'invalid_session',
          );
        }
        return Promise.resolve({
          service: options.service,
          scope: options.scope ?? testScope,
        });
      },
    },
    ...(options.healthCheck === undefined
      ? {}
      : { healthCheck: options.healthCheck }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });
}

const defaultTestHandler = authenticatedHandler({
  service: new FixtureMcpToolService(),
});
const durableTestHandler = authenticatedHandler({
  service: new ProductServiceMcpAdapter(
    testDependencies.productService,
    testContext,
  ),
  scope: {
    kind: 'verified_identity',
    tenantId: testContext.actor.tenantId,
    userId: testContext.actor.userId,
    authorizationEpoch: testContext.retrievalScope?.authorizationEpoch ?? 1,
  },
});

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: Readonly<{ code: number; message: string }>;
}

function event(options: {
  readonly method?: string;
  readonly rawPath?: string;
  readonly rawQueryString?: string;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: options.rawPath ?? '/mcp',
    rawQueryString: options.rawQueryString ?? '',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      host: 'mcp.example.test',
      authorization: `Bearer ${TEST_BEARER}`,
      ...options.headers,
    },
    requestContext: {
      accountId: 'fixture',
      apiId: 'fixture',
      domainName: 'mcp.example.test',
      domainPrefix: 'mcp',
      http: {
        method: options.method ?? 'POST',
        path: options.rawPath ?? '/mcp',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'request-1',
      routeKey: '$default',
      stage: '$default',
      time: '17/Jul/2026:12:00:00 +0000',
      timeEpoch: 1_768_564_800_000,
    },
    body: options.body,
    isBase64Encoded: options.isBase64Encoded ?? false,
  };
}

function rpcRequest(
  method: string,
  params?: Readonly<Record<string, unknown>>,
  id: number | string = 1,
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

async function invoke(
  body: string,
  selectedHandler = defaultTestHandler,
): Promise<{
  readonly response: APIGatewayProxyStructuredResultV2;
  readonly rpc: JsonRpcResponse;
}> {
  const response = (await selectedHandler(
    event({ body }),
  )) as APIGatewayProxyStructuredResultV2;
  return {
    response,
    rpc: JSON.parse(response.body ?? '{}') as JsonRpcResponse,
  };
}

async function callTool(
  name: string,
  args: Readonly<Record<string, unknown>>,
  selectedHandler = defaultTestHandler,
) {
  const { response, rpc } = await invoke(
    rpcRequest('tools/call', { name, arguments: args }),
    selectedHandler,
  );
  const result = rpc.result as
    | {
        readonly isError?: boolean;
        readonly structuredContent?: Readonly<Record<string, unknown>>;
        readonly content?: readonly {
          readonly type: string;
          readonly text: string;
        }[];
      }
    | undefined;
  return { response, rpc, result };
}

describe('Chief remote MCP Lambda', () => {
  const frozenFixtureHandler = authenticatedHandler({
    service: new FixtureMcpToolService(),
  });
  it('accepts only a credential-free HTTPS product origin', () => {
    expect(configuredProductBaseUrl('https://chief.example.test')).toBe(
      'https://chief.example.test',
    );
    expect(() =>
      configuredProductBaseUrl(
        'https://raw-user:raw-password@chief.example.test',
      ),
    ).toThrow('credential-free HTTPS origin');
  });

  it('reports public liveness without external effects', async () => {
    const healthEvent = event({ method: 'GET', rawPath: '/mcp/health' });
    delete healthEvent.headers.authorization;
    healthEvent.headers.cookie = '__Host-chief_session=not-an-mcp-credential';
    const response = (await frozenFixtureHandler(
      healthEvent,
    )) as APIGatewayProxyStructuredResultV2;
    const body = JSON.parse(response.body ?? '{}') as Record<string, unknown>;

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    });
    expect(body).toEqual({
      service: 'chief-mcp',
      status: 'ok',
      protocol: 'mcp-streamable-http',
      externalEffects: 'disabled',
      tenantSelection: 'server',
    });
  });

  it('requires a bearer token before every non-health MCP request', async () => {
    const missing = event({ body: rpcRequest('tools/list') });
    delete missing.headers.authorization;
    const response = (await frozenFixtureHandler(
      missing,
    )) as APIGatewayProxyStructuredResultV2;

    expect(response.statusCode).toBe(401);
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'www-authenticate': 'Bearer realm="chief-mcp"',
    });
    expect(JSON.parse(response.body ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32_001, message: 'Authentication is required.' },
    });
  });

  it('does not widen the public health exception to nested MCP paths', async () => {
    const nested = event({ method: 'GET', rawPath: '/mcp/private/health' });
    delete nested.headers.authorization;
    const response = (await frozenFixtureHandler(
      nested,
    )) as APIGatewayProxyStructuredResultV2;

    expect(response.statusCode).toBe(401);
  });

  it.each([
    ['basic authorization', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['malformed bearer', { authorization: 'Bearer not-a-jwt' }],
    [
      'duplicate authorization',
      {
        authorization: `Bearer ${TEST_BEARER}`,
        Authorization: `Bearer ${TEST_BEARER}`,
      },
    ],
  ])('rejects %s without reflecting credentials', async (_label, input) => {
    const response = (await frozenFixtureHandler(
      event({ body: rpcRequest('tools/list'), headers: input }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('Authentication is required.');
    expect(response.body).not.toContain('Basic');
    expect(response.body).not.toContain(TEST_BEARER);
    expect(response.body).not.toContain('not-a-jwt');
  });

  it('rejects browser cookies even alongside a valid bearer token', async () => {
    const resolve = vi.fn(() =>
      Promise.resolve({
        service: new FixtureMcpToolService(),
        scope: testScope,
      }),
    );
    const cookieRejectingHandler = createHandler({
      adapterResolver: { resolve },
    });
    const response = (await cookieRejectingHandler(
      event({
        body: rpcRequest('tools/list'),
        headers: { cookie: '__Host-chief_session=opaque-browser-session' },
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(response.statusCode).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
    expect(response.body).not.toContain('opaque-browser-session');
  });

  it('rejects API Gateway v2 cookie arrays before resolving authority', async () => {
    const resolve = vi.fn(() =>
      Promise.resolve({
        service: new FixtureMcpToolService(),
        scope: testScope,
      }),
    );
    const cookieRejectingHandler = createHandler({
      adapterResolver: { resolve },
    });
    const cookieEvent = event({ body: rpcRequest('tools/list') });
    cookieEvent.cookies = ['__Host-chief_session=opaque-browser-session'];

    const response = (await cookieRejectingHandler(
      cookieEvent,
    )) as APIGatewayProxyStructuredResultV2;

    expect(response.statusCode).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
    expect(response.body).not.toContain('opaque-browser-session');
  });

  it('maps inactive membership to one non-leaking forbidden response', async () => {
    const inactiveHandler = createHandler({
      adapterResolver: {
        resolve: () =>
          Promise.reject(
            new RequestAuthorityError('forbidden', 'inactive_membership'),
          ),
      },
    });
    const response = (await inactiveHandler(
      event({ body: rpcRequest('tools/list') }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(response.statusCode).toBe(403);
    expect(response.headers).not.toHaveProperty('www-authenticate');
    expect(response.body).toContain('The request is not permitted.');
    expect(response.body).not.toContain('inactive_membership');
    expect(response.body).not.toContain(testContext.actor.tenantId);
  });

  it('derives an independent product context and scope for every verified membership', async () => {
    const firstContext = serverRequestContextSchema.parse({
      actor: {
        ...testContext.actor,
        tenantId: 'tenant-membership-a',
        userId: 'user-membership-a',
        accountScopes: ['account-a'],
        brandScopes: ['brand-a'],
        grants: ['communications:read'],
        membershipVersion: 3,
      },
      retrievalScope: {
        ...testContext.retrievalScope!,
        tenantId: 'tenant-membership-a',
        accountIds: ['account-a'],
        brandIds: ['brand-a'],
        authorizationEpoch: 3,
      },
    });
    const secondContext = serverRequestContextSchema.parse({
      actor: {
        ...testContext.actor,
        tenantId: 'tenant-membership-b',
        userId: 'user-membership-b',
        accountScopes: ['account-b'],
        brandScopes: ['brand-b'],
        grants: ['knowledge:read', 'actions:prepare'],
        membershipVersion: 8,
      },
      retrievalScope: {
        ...testContext.retrievalScope!,
        tenantId: 'tenant-membership-b',
        accountIds: ['account-b'],
        brandIds: ['brand-b'],
        authorizationEpoch: 8,
      },
    });
    const observed: ProductRequestContext[] = [];
    const productService = {
      getConnectorStatus: (context: ProductRequestContext) => {
        observed.push(context);
        return Promise.resolve({ connectors: [] });
      },
    } as unknown as ProductService;
    const resolveAuthority = vi
      .fn()
      .mockResolvedValueOnce({
        mode: 'verified-session' as const,
        requestContext: firstContext,
      })
      .mockResolvedValueOnce({
        mode: 'verified-session' as const,
        requestContext: secondContext,
      });
    const resolver = createMcpAdapterResolver({
      productService,
      requestAuthorityResolver: { resolve: resolveAuthority },
    });

    const first = await resolver.resolve({ headers: {} });
    const second = await resolver.resolve({ headers: {} });
    await first.service.call('get_connector_status', {}, first.scope);
    await second.service.call('get_connector_status', {}, second.scope);

    expect(resolveAuthority).toHaveBeenCalledTimes(2);
    expect(first.scope).toEqual({
      kind: 'verified_identity',
      tenantId: 'tenant-membership-a',
      userId: 'user-membership-a',
      authorizationEpoch: 3,
    });
    expect(second.scope).toEqual({
      kind: 'verified_identity',
      tenantId: 'tenant-membership-b',
      userId: 'user-membership-b',
      authorizationEpoch: 8,
    });
    expect(
      observed.map(({ actor, retrievalScope }) => ({
        accounts: actor.accountScopes,
        brands: actor.brandScopes,
        grants: actor.grants,
        epoch: retrievalScope?.authorizationEpoch,
      })),
    ).toEqual([
      {
        accounts: ['account-a'],
        brands: ['brand-a'],
        grants: ['communications:read'],
        epoch: 3,
      },
      {
        accounts: ['account-b'],
        brands: ['brand-b'],
        grants: ['knowledge:read', 'actions:prepare'],
        epoch: 8,
      },
    ]);
  });

  it('fails health closed when its configured readiness check fails', async () => {
    const fixture = new FixtureMcpToolService();
    const unavailableHandler = authenticatedHandler({
      service: fixture,
      healthCheck: () => Promise.reject(new Error('injected failure')),
    });
    const response = (await unavailableHandler(
      event({ method: 'GET', rawPath: '/mcp/health' }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body ?? '{}')).toMatchObject({
      service: 'chief-mcp',
      status: 'unavailable',
      externalEffects: 'disabled',
      tenantSelection: 'server',
    });
  });

  it('negotiates MCP initialize over stateless Streamable HTTP', async () => {
    const { response, rpc } = await invoke(
      rpcRequest('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'chief-test', version: '1.0.0' },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers?.['content-type']).toContain('application/json');
    expect(rpc.error).toBeUndefined();
    expect(rpc.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: {
        name: 'chief-of-staff-communication-agent',
        version: '1.0.0',
      },
      capabilities: { tools: { listChanged: true } },
    });
  });

  it('lists exactly the frozen bounded tools with schemas and no direct effects', async () => {
    const { rpc } = await invoke(rpcRequest('tools/list'));
    const tools = (rpc.result?.tools ?? []) as readonly {
      readonly name: string;
      readonly inputSchema?: unknown;
      readonly outputSchema?: unknown;
    }[];
    const names = tools.map(({ name }) => name);

    expect(names).toEqual(mcpToolNameSchema.options);
    expect(tools.every(({ inputSchema }) => inputSchema !== undefined)).toBe(
      true,
    );
    expect(tools.every(({ outputSchema }) => outputSchema !== undefined)).toBe(
      true,
    );
    expect(names).not.toContain('approve');
    expect(names).not.toContain('send_message');
    expect(names).not.toContain('create_task');
    expect(names).not.toContain('update_task');
  });

  it('initializes, describes, and truthfully rejects the legacy approval tool in the default durable handler', async () => {
    const initialized = await invoke(
      rpcRequest('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'durable-approval-test', version: '1.0.0' },
      }),
      durableTestHandler,
    );
    expect(initialized.rpc.error).toBeUndefined();

    const listed = await invoke(rpcRequest('tools/list'), durableTestHandler);
    const tools = (listed.rpc.result?.tools ?? []) as readonly {
      readonly name: string;
      readonly description?: string;
    }[];
    expect(
      tools.find(({ name }) => name === 'submit_for_approval')?.description,
    ).toBe(
      'Legacy compatibility tool; unavailable in the durable fixed-scope MCP runtime. Use the HTTPS product draft-approval flow. No effect is executed.',
    );

    const rejected = await callTool(
      'submit_for_approval',
      {
        actionPlanId: publicFixtureIdentifiers.actionPlanId,
        expectedActionPlanRevision: publicFixtureIdentifiers.actionPlanRevision,
        actionPlanHash: publicFixtureIdentifiers.actionPlanHash,
      },
      durableTestHandler,
    );
    expect(rejected.rpc.error).toBeUndefined();
    expect(rejected.result).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'TOOL_UNAVAILABLE: submit_for_approval is legacy and unavailable in the durable fixed-scope MCP runtime; use the HTTPS product draft-approval flow.',
        },
      ],
    });
    expect(rejected.result?.structuredContent).toBeUndefined();
  });

  it('runs initialize, list, and honest evidence abstention through durable composition', async () => {
    const dependencies = createMemoryDurableApiDependencies({
      baseUrl: 'https://chief.example.test',
    });
    const context = dependencies.requestContext;
    const durableHandler = authenticatedHandler({
      service: new ProductServiceMcpAdapter(
        dependencies.productService,
        context,
      ),
      scope: {
        kind: 'public_fixture',
        tenantId: context.actor.tenantId,
        userId: context.actor.userId,
        authorizationEpoch: context.retrievalScope?.authorizationEpoch ?? 1,
      },
    });

    const initialized = await invoke(
      rpcRequest('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'durable-test', version: '1.0.0' },
      }),
      durableHandler,
    );
    expect(initialized.rpc.error).toBeUndefined();
    const listed = await invoke(rpcRequest('tools/list'), durableHandler);
    expect(listed.rpc.result?.tools).toBeDefined();

    const searched = await callTool(
      'search_knowledge',
      {
        queryText: 'Friday launch owner',
        exactEntityRefs: [
          deterministicEvaluatorIdentityV1.communications[0]
            .retrievalExactEntityRef,
        ],
        limit: 2,
      },
      durableHandler,
    );
    expect(
      mcpSearchKnowledgeResultSchema.parse(searched.result?.structuredContent),
    ).toEqual({ candidates: [], citations: [] });

    const recommended = await callTool(
      'recommend_action',
      {
        messageRevisionId: 'message-revision-1-1',
        expectedMessageRevision: 1,
      },
      durableHandler,
    );
    const recommendation = mcpRecommendActionResultSchema.parse(
      recommended.result?.structuredContent,
    ).recommendation;
    expect(recommendation).toMatchObject({
      actionType: 'request_context',
      status: 'needs_context',
      citations: [],
    });
  });

  it.each([
    ['list_pending_communications', { limit: 1 }],
    ['get_communication', { messageRevisionId: 'message-revision-1-1' }],
    ['get_thread_context', { threadId: 'thread-1', limit: 10 }],
    [
      'search_knowledge',
      { queryText: 'launch owner', exactEntityRefs: [], limit: 2 },
    ],
    [
      'get_related_asana_work',
      { messageRevisionId: 'message-revision-1-1', limit: 10 },
    ],
    [
      'recommend_action',
      {
        messageRevisionId: 'message-revision-1-1',
        expectedMessageRevision: 1,
      },
    ],
    [
      'create_draft',
      {
        recommendationId: publicFixtureIdentifiers.recommendationId,
        expectedRecommendationRevision: 1,
      },
    ],
    [
      'revise_draft',
      {
        draftRevisionId: 'draft-recommendation-1-revision-1',
        expectedDraftRevision: 1,
        revisionInstruction: 'Make the owner commitment explicit.',
      },
    ],
    [
      'request_context',
      {
        recommendationId: publicFixtureIdentifiers.recommendationId,
        expectedRecommendationRevision: 1,
      },
    ],
    [
      'prepare_asana_action',
      {
        recommendationId: publicFixtureIdentifiers.recommendationId,
        expectedRecommendationRevision: 1,
      },
    ],
    [
      'submit_for_approval',
      {
        actionPlanId: publicFixtureIdentifiers.actionPlanId,
        expectedActionPlanRevision: publicFixtureIdentifiers.actionPlanRevision,
        actionPlanHash: publicFixtureIdentifiers.actionPlanHash,
      },
    ],
    [
      'get_approval_status',
      { proposalId: publicFixtureIdentifiers.approvalProposalId },
    ],
    ['get_connector_status', {}],
    ['get_sla_metrics', { window: '24h' }],
  ] as const)(
    'executes %s through its frozen input and output schemas',
    async (name, args) => {
      const { response, rpc, result } = await callTool(
        name,
        args,
        frozenFixtureHandler,
      );

      expect(response.statusCode).toBe(200);
      expect(rpc.error).toBeUndefined();
      expect(result?.isError).not.toBe(true);
      expect(result?.structuredContent).toBeDefined();
    },
  );

  it('does not fabricate exact-scoped citations without durable evidence', async () => {
    const { response, result } = await callTool(
      'search_knowledge',
      {
        queryText: 'Friday launch owner',
        exactEntityRefs: [
          deterministicEvaluatorIdentityV1.communications[0]
            .retrievalExactEntityRef,
        ],
        limit: 2,
      },
      durableTestHandler,
    );

    expect(response.statusCode).toBe(200);
    expect(result?.isError).not.toBe(true);
    const output = mcpSearchKnowledgeResultSchema.parse(
      result?.structuredContent,
    );
    expect(output.candidates).toHaveLength(0);
    expect(output.citations).toHaveLength(0);
    expect(output.candidates.map(({ chunkId }) => chunkId)).toEqual(
      output.citations.map(({ chunkId }) => chunkId),
    );
    expect(
      output.citations.every(
        ({ hydratedUnderAuthorizationEpoch }) =>
          hydratedUnderAuthorizationEpoch === 1,
      ),
    ).toBe(true);
  });

  it('mirrors the product API communication fixture and cursor semantics', async () => {
    const fixtureHandler = authenticatedHandler({
      service: new FixtureMcpToolService(),
    });
    const firstPage = await callTool(
      'list_pending_communications',
      { limit: 3 },
      fixtureHandler,
    );
    const firstOutput = mcpListPendingResultSchema.parse(
      firstPage.result?.structuredContent,
    );
    const secondPage = await callTool(
      'list_pending_communications',
      { limit: 3, cursor: firstOutput.nextCursor },
      fixtureHandler,
    );
    const secondOutput = mcpListPendingResultSchema.parse(
      secondPage.result?.structuredContent,
    );
    const items = [...firstOutput.items, ...secondOutput.items];

    expect(firstOutput.totalCount).toBe(5);
    expect(secondOutput.totalCount).toBe(5);
    expect(items.map(({ messageRevisionId }) => messageRevisionId)).toEqual([
      'message-revision-1-1',
      'message-revision-2-1',
      'message-revision-3-1',
      'message-revision-4-1',
      'message-revision-5-1',
    ]);
    expect(items.map(({ status }) => status)).toEqual([
      'overdue',
      'pending',
      'pending',
      'answered',
      'resolved',
    ]);
    expect(secondOutput.nextCursor).toBeUndefined();

    const filtered = mcpListPendingResultSchema.parse(
      (
        await callTool(
          'list_pending_communications',
          {
            limit: 10,
            query: 'customer escalation',
            channel: 'sms',
            accountFilter: 'account-twilio-fixture',
            brandFilter: 'brand-executive',
          },
          fixtureHandler,
        )
      ).result?.structuredContent,
    );
    expect(filtered).toMatchObject({
      totalCount: 1,
      items: [
        {
          messageRevisionId: 'message-revision-3-1',
          channel: 'sms',
          accountId: 'account-twilio-fixture',
          brandId: 'brand-executive',
        },
      ],
    });

    const emailThread = mcpGetThreadContextResultSchema.parse(
      (
        await callTool(
          'get_thread_context',
          { threadId: 'thread-1', limit: 10 },
          fixtureHandler,
        )
      ).result?.structuredContent,
    );
    const smsThread = mcpGetThreadContextResultSchema.parse(
      (
        await callTool(
          'get_thread_context',
          { threadId: 'thread-3', limit: 10 },
          fixtureHandler,
        )
      ).result?.structuredContent,
    );

    expect(emailThread.thread).toMatchObject({
      threadId: 'thread-1',
      channel: 'email',
      latestMessageRevisionId: 'message-revision-4-1',
    });
    expect(
      emailThread.thread.communications.map(
        ({ messageRevisionId }) => messageRevisionId,
      ),
    ).toEqual(['message-revision-1-1', 'message-revision-4-1']);
    expect(smsThread.thread).toMatchObject({
      threadId: 'thread-3',
      channel: 'sms',
      latestMessageRevisionId: 'message-revision-3-1',
    });
  });

  it('mirrors product connector, Asana, knowledge, and SLA facts', async () => {
    const fixtureHandler = authenticatedHandler({
      service: new FixtureMcpToolService(),
    });
    const connectors = mcpGetConnectorStatusResultSchema.parse(
      (await callTool('get_connector_status', {}, fixtureHandler)).result
        ?.structuredContent,
    );
    expect(
      connectors.connectors.map(
        ({ connectorId, runtimeMode, selectionState }) => ({
          connectorId,
          runtimeMode,
          selectionState,
        }),
      ),
    ).toEqual([
      {
        connectorId: 'gmail',
        runtimeMode: 'fixture',
        selectionState: 'selected',
      },
      {
        connectorId: 'twilio-sms',
        runtimeMode: 'fixture',
        selectionState: 'selected',
      },
      {
        connectorId: 'microsoft-graph',
        runtimeMode: 'disabled',
        selectionState: 'unselected_candidate',
      },
      {
        connectorId: 'asana',
        runtimeMode: 'fixture',
        selectionState: 'selected',
      },
    ]);
    expect(
      connectors.connectors.every(
        ({ capabilities }) => capabilities.externalEffect === false,
      ),
    ).toBe(true);

    const relatedWork = mcpGetRelatedAsanaWorkResultSchema.parse(
      (
        await callTool(
          'get_related_asana_work',
          { messageRevisionId: 'message-revision-1-1', limit: 10 },
          fixtureHandler,
        )
      ).result?.structuredContent,
    );
    expect(
      relatedWork.items.map(({ kind, providerObjectId }) => ({
        kind,
        providerObjectId,
      })),
    ).toEqual([
      {
        kind: 'task',
        providerObjectId: 'asana-task-launch-readiness',
      },
      {
        kind: 'project',
        providerObjectId: 'asana-project-customer-operations',
      },
    ]);

    const knowledge = mcpSearchKnowledgeResultSchema.parse(
      (
        await callTool(
          'search_knowledge',
          { queryText: 'Can we', exactEntityRefs: [], limit: 5 },
          fixtureHandler,
        )
      ).result?.structuredContent,
    );
    expect(knowledge.candidates).toEqual([
      expect.objectContaining({
        chunkId: 'chunk-search-0',
        sourceId: 'source-search-message-1',
      }),
    ]);
    expect(knowledge.citations[0]).toMatchObject({
      chunkId: 'chunk-search-0',
      sourceId: 'source-search-message-1',
      label: 'Authorized communication result 1',
    });

    const sla = mcpGetSlaMetricsResultSchema.parse(
      (await callTool('get_sla_metrics', { window: '24h' }, fixtureHandler))
        .result?.structuredContent,
    );
    expect(sla.snapshot).toMatchObject({
      pendingCount: 2,
      overdueCount: 1,
      answeredCount: 1,
      resolvedCount: 1,
      responseTimeP50Ms: 42_000,
      responseTimeP95Ms: 118_000,
      ingestionLagP95Ms: 24_000,
    });
  });

  it('mirrors product recommendation, draft, context, and proposal identifiers', async () => {
    const fixtureHandler = authenticatedHandler({
      service: new FixtureMcpToolService(),
    });
    const recommendation = mcpRecommendActionResultSchema.parse(
      (
        await callTool(
          'recommend_action',
          {
            messageRevisionId: 'message-revision-1-1',
            expectedMessageRevision: 1,
          },
          fixtureHandler,
        )
      ).result?.structuredContent,
    );
    expect(recommendation.recommendation).toMatchObject({
      tenantId: publicFixtureIdentifiers.tenantId,
      recommendationId: 'recommendation-1',
      sourceMessageRevisionId: 'message-revision-1-1',
      actionType: 'reply',
      confidence: 0.87,
    });

    const draft = mcpCreateDraftResultSchema.parse(
      (
        await callTool(
          'create_draft',
          {
            recommendationId: 'recommendation-1',
            expectedRecommendationRevision: 1,
          },
          fixtureHandler,
        )
      ).result?.structuredContent,
    );
    expect(draft.result.draft).toMatchObject({
      draftId: 'draft-recommendation-1',
      draftRevisionId: 'draft-recommendation-1-revision-1',
      connectorAccountId: 'account-gmail-fixture',
      body: 'Thanks for the note. QA ownership is confirmed, and I will send the final launch update today.',
    });
    expect(draft.result.draft.citations).toHaveLength(1);

    const context = mcpRequestContextResultSchema.parse(
      (
        await callTool(
          'request_context',
          {
            recommendationId: 'recommendation-2',
            expectedRecommendationRevision: 1,
          },
          fixtureHandler,
        )
      ).result?.structuredContent,
    );
    expect(context.request).toMatchObject({
      contextRequestId: 'context-recommendation-2',
      recommendationId: 'recommendation-2',
      focusedQuestion:
        'Which approved metric set should I use in the board response?',
      missingFacts: ['approved pipeline metric set'],
    });

    const approval = proposalHandoffSchema.parse(
      (
        await callTool(
          'submit_for_approval',
          {
            actionPlanId: publicFixtureIdentifiers.actionPlanId,
            expectedActionPlanRevision:
              publicFixtureIdentifiers.actionPlanRevision,
            actionPlanHash: publicFixtureIdentifiers.actionPlanHash,
          },
          fixtureHandler,
        )
      ).result?.structuredContent,
    );
    expect(approval).toMatchObject({
      proposalId: publicFixtureIdentifiers.approvalProposalId,
      status: 'pending_approval',
      directEffectAvailable: false,
    });

    const effectDisabledStatus = mcpGetApprovalStatusResultSchema.parse(
      (
        await callTool(
          'get_approval_status',
          { proposalId: publicFixtureIdentifiers.effectDisabledProposalId },
          fixtureHandler,
        )
      ).result?.structuredContent,
    );
    expect(effectDisabledStatus).toMatchObject({
      proposalId: 'proposal_fixture_effect_disabled',
      status: 'approved',
    });
  });

  it('creates an idempotent immutable approval handoff with no direct effect', async () => {
    const fixtureHandler = authenticatedHandler({
      service: new FixtureMcpToolService(),
    });
    const args = {
      actionPlanId: publicFixtureIdentifiers.actionPlanId,
      expectedActionPlanRevision: publicFixtureIdentifiers.actionPlanRevision,
      actionPlanHash: publicFixtureIdentifiers.actionPlanHash,
    };
    const first = await callTool('submit_for_approval', args, fixtureHandler);
    const second = await callTool('submit_for_approval', args, fixtureHandler);
    const firstProposal = proposalHandoffSchema.parse(
      first.result?.structuredContent,
    );
    const secondProposal = proposalHandoffSchema.parse(
      second.result?.structuredContent,
    );

    expect(firstProposal).toEqual(secondProposal);
    expect(firstProposal.status).toBe('pending_approval');
    expect(firstProposal.directEffectAvailable).toBe(false);
    expect(new URL(firstProposal.approvalUrl).protocol).toBe('https:');
  });

  it('rejects stale revisions without returning a proposal or performing work', async () => {
    const { result } = await callTool('recommend_action', {
      messageRevisionId: 'message-revision-1-1',
      expectedMessageRevision: 2,
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toBeUndefined();
    expect(result?.content?.[0]?.text).toBe('STALE_REVISION');
  });

  it('rejects caller-supplied tenant/account authority through strict schemas', async () => {
    const { result } = await callTool('list_pending_communications', {
      limit: 10,
      tenantId: 'tenant-attacker',
      accountId: 'account-attacker',
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('tenant-public-assessment');
  });

  it('rejects valid but cross-tenant output from an injected service', async () => {
    const fixtureService = new FixtureMcpToolService();
    const crossTenantService: McpToolService = {
      call: (toolName, input, scope) => {
        const output = fixtureService.call(toolName, input, scope);
        if (
          toolName !== 'recommend_action' ||
          output === null ||
          typeof output !== 'object' ||
          !('recommendation' in output)
        ) {
          return output;
        }
        const recommendation = output.recommendation;
        if (recommendation === null || typeof recommendation !== 'object') {
          return output;
        }
        return {
          ...output,
          recommendation: {
            ...recommendation,
            tenantId: 'tenant-cross-boundary',
          },
        };
      },
    };
    const crossTenantHandler = authenticatedHandler({
      service: crossTenantService,
    });
    const { result } = await callTool(
      'recommend_action',
      {
        messageRevisionId: 'message-revision-1-1',
        expectedMessageRevision: 1,
      },
      crossTenantHandler,
    );

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toBeUndefined();
    expect(result?.content?.[0]?.text).toBe('SCOPE_VIOLATION');
    expect(JSON.stringify(result)).not.toContain('tenant-cross-boundary');
  });

  it('denies unknown recommendation, action-plan, and proposal identifiers', async () => {
    const fixtureHandler = authenticatedHandler({
      service: new FixtureMcpToolService(),
    });
    const unknownRecommendation = await callTool(
      'prepare_asana_action',
      {
        recommendationId: 'recommendation-unknown',
        expectedRecommendationRevision: 1,
      },
      fixtureHandler,
    );
    const unknownActionPlan = await callTool(
      'submit_for_approval',
      {
        actionPlanId: 'action-plan-unknown',
        expectedActionPlanRevision: 1,
        actionPlanHash: 'c'.repeat(64),
      },
      fixtureHandler,
    );
    const unknownProposal = await callTool(
      'get_approval_status',
      { proposalId: 'proposal-unknown' },
      fixtureHandler,
    );

    expect(unknownRecommendation.result?.isError).toBe(true);
    expect(unknownRecommendation.result?.content?.[0]?.text).toBe('NOT_FOUND');
    expect(unknownActionPlan.result?.isError).toBe(true);
    expect(unknownActionPlan.result?.content?.[0]?.text).toBe('STALE_REVISION');
    expect(unknownProposal.result?.isError).toBe(true);
    expect(unknownProposal.result?.content?.[0]?.text).toBe('NOT_FOUND');
  });

  it('does not expose or execute unknown direct-effect tools', async () => {
    const { result } = await callTool('send_message', {
      recipient: 'victim@example.test',
      body: 'unauthorized',
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toBeUndefined();
  });

  it('returns protocol errors for malformed JSON and unknown JSON-RPC methods', async () => {
    const malformed = await invoke('{');
    const unknown = await invoke(rpcRequest('chief/unknown'));

    expect(malformed.response.statusCode).toBe(400);
    expect(malformed.rpc.error?.code).toBe(-32_700);
    expect(unknown.rpc.error?.code).toBe(-32_601);
  });

  it('bounds request bodies before JSON parsing', async () => {
    const response = (await frozenFixtureHandler(
      event({ body: 'x'.repeat(64 * 1024 + 1) }),
    )) as APIGatewayProxyStructuredResultV2;
    const rpc = JSON.parse(response.body ?? '{}') as JsonRpcResponse;

    expect(response.statusCode).toBe(413);
    expect(rpc.error).toEqual({
      code: -32_600,
      message: 'Request body exceeds the limit.',
    });
  });

  it('rejects URL query authority including bearer tokens without reflecting it', async () => {
    const response = (await frozenFixtureHandler(
      event({
        rawQueryString: 'access_token=super-secret&tenantId=attacker',
        body: rpcRequest('tools/list'),
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('super-secret');
    expect(response.body).not.toContain('attacker');
  });

  it('decodes API Gateway base64 bodies', async () => {
    const body = rpcRequest('tools/list');
    const response = (await frozenFixtureHandler(
      event({
        body: Buffer.from(body, 'utf8').toString('base64'),
        isBase64Encoded: true,
      }),
    )) as APIGatewayProxyStructuredResultV2;
    const rpc = JSON.parse(response.body ?? '{}') as JsonRpcResponse;

    expect(response.statusCode).toBe(200);
    expect(rpc.result?.tools).toBeDefined();
  });

  it('turns bounded service timeouts into redacted tool errors', async () => {
    const hangingService: McpToolService = {
      call: () => new Promise(() => undefined),
    };
    const timeoutHandler = authenticatedHandler({
      service: hangingService,
      timeoutMs: 5,
    });
    const { result } = await callTool(
      'list_pending_communications',
      { limit: 1 },
      timeoutHandler,
    );

    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toBe('TOOL_TIMEOUT');
    expect(result?.structuredContent).toBeUndefined();
  });
});
