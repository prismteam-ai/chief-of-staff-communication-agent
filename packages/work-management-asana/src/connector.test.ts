import { createHmac } from 'node:crypto';

import {
  effectExecutionArtifactSchema,
  reconcileSendRequestSchema,
} from '@chief/contracts/approval';
import {
  authorizationInputSchema,
  connectorAccountRefSchema,
  pollRequestSchema,
  rawWebhookRequestSchema,
  subscriptionMutationRequestSchema,
} from '@chief/contracts/connectors';
import type {
  PollRequest,
  RawWebhookRequest,
} from '@chief/contracts/connectors';
import {
  dispatchWorkManagementEffect,
  UnknownAcceptanceRetryError,
} from '@chief/connector-core';
import {
  createConnectorContractFixtures,
  ExactFixtureArtifactAuthority,
  InMemoryEffectPersistence,
  runWorkManagementConnectorContract,
} from '@chief/connector-testkit';
import { describe, expect, it } from 'vitest';

import {
  AsanaWorkManagementConnector,
  createAsanaWorkManagementConnector,
} from './connector.js';
import type { AsanaRateLimitError } from './connector.js';
import { asanaWorkManagementConnectorDescriptor } from './implementation-metadata.js';
import {
  ASANA_FIXTURE_LATER,
  ASANA_FIXTURE_NOW,
  asanaFixtureAccount,
  asanaFixtureArtifact,
  asanaFixtureComment,
  asanaFixtureMilestone,
  asanaFixtureProject,
  asanaFixtureSnapshot,
  asanaFixtureTask,
  asanaFixtureUpdatePayload,
  providerResponse,
  type AsanaFixtureRoute,
} from './provider-fixtures.js';
import type {
  AsanaConnectorOptions,
  AsanaEffectPayload,
  AsanaRequest,
  AsanaTransport,
} from './types.js';

class ProviderShapedTransport implements AsanaTransport {
  public readonly requests: AsanaRequest[] = [];
  readonly #route: AsanaFixtureRoute;
  public reconciliation:
    | Awaited<ReturnType<NonNullable<AsanaTransport['reconcileEffect']>>>
    | undefined = {
    outcome: 'accepted',
    gid: 'task-a',
    response: { data: { gid: 'task-a', resource_type: 'task' } },
  };

  public constructor(route?: AsanaFixtureRoute) {
    this.#route = route ?? defaultRoute;
  }

  public async request(request: AsanaRequest) {
    this.requests.push(request);
    return this.#route(request);
  }

  public reconcileEffect = () => {
    if (this.reconciliation === undefined) {
      return Promise.resolve({
        outcome: 'unknown' as const,
        reasonCode: 'fixture_missing',
      });
    }
    return Promise.resolve(this.reconciliation);
  };
}

function defaultRoute(request: AsanaRequest) {
  if (request.path === '/users/me') {
    return providerResponse(200, {
      data: {
        gid: 'user-asana-a',
        name: 'Fixture Operator',
        workspaces: [{ gid: 'workspace-a', name: 'Fixture Workspace' }],
      },
    });
  }
  if (request.path === '/tasks/task-a' && request.method === 'GET') {
    return providerResponse(200, asanaFixtureTask);
  }
  if (request.path === '/projects/project-a') {
    return providerResponse(200, asanaFixtureProject);
  }
  if (request.path === '/tasks/milestone-a') {
    return providerResponse(200, asanaFixtureMilestone);
  }
  if (request.path === '/stories/comment-a') {
    return providerResponse(200, asanaFixtureComment);
  }
  if (request.path === '/webhooks' && request.method === 'POST') {
    return providerResponse(201, {
      data: {
        gid: 'webhook-a',
        resource: { gid: 'workspace-a', resource_type: 'workspace' },
        target: 'https://example.invalid/hooks/asana',
        active: true,
        created_at: ASANA_FIXTURE_NOW,
      },
    });
  }
  if (request.path === '/webhooks' && request.method === 'GET') {
    return providerResponse(200, {
      data: [
        {
          gid: 'webhook-a',
          resource: { gid: 'workspace-a', resource_type: 'workspace' },
          target: 'https://example.invalid/hooks/asana',
          active: true,
          last_failure_at: null,
          last_success_at: ASANA_FIXTURE_NOW,
        },
      ],
    });
  }
  if (request.path === '/events') {
    return providerResponse(200, {
      data: [
        {
          action: 'changed',
          resource: {
            gid: 'task-a',
            resource_type: 'task',
            resource_subtype: 'default_task',
          },
          created_at: ASANA_FIXTURE_NOW,
        },
      ],
      sync: 'sync-token-b',
      next_page: null,
    });
  }
  if (
    (request.path === '/tasks/task-a' && request.method === 'PUT') ||
    request.path === '/tasks' ||
    request.path === '/tasks/task-a/stories'
  ) {
    const gid = request.path.endsWith('/stories')
      ? 'comment-returned-a'
      : request.path === '/tasks'
        ? 'task-returned-a'
        : 'task-a';
    return providerResponse(request.method === 'POST' ? 201 : 200, {
      data: {
        gid,
        resource_type: request.path.endsWith('/stories') ? 'story' : 'task',
      },
    });
  }
  return providerResponse(404, { errors: [{ message: 'Not found' }] });
}

function options(
  transport: AsanaTransport,
  payload: AsanaEffectPayload = asanaFixtureUpdatePayload,
): AsanaConnectorOptions {
  return {
    clientId: 'asana-client-fixture',
    scope: {
      workspaceGid: 'workspace-a',
      projectGids: ['project-a'],
      pollingResourceGids: ['workspace-a'],
    },
    currentSnapshot: asanaFixtureSnapshot,
    transport,
    authorization: {
      completeAuthorization: () => Promise.resolve(asanaFixtureAccount),
    },
    effectPayloads: {
      loadExactPayload: () => Promise.resolve(payload),
    },
    webhookVerificationKey: ['fixture', 'webhook', 'key'].join('-'),
    webhookTargetUrl: 'https://example.invalid/hooks/asana',
    clock: { now: () => ASANA_FIXTURE_LATER },
  };
}

function accountRef() {
  return connectorAccountRefSchema.parse({
    tenantId: asanaFixtureAccount.tenantId,
    accountId: asanaFixtureAccount.accountId,
    expectedStateVersion: asanaFixtureAccount.stateVersion,
  });
}

function pollRequest(maxPages = 2, maxItems = 100): PollRequest {
  return pollRequestSchema.parse({
    schemaVersion: '1',
    account: accountRef(),
    resourceScopeHash: 'c'.repeat(64),
    checkpoint: {
      schemaVersion: '1',
      tenantId: asanaFixtureAccount.tenantId,
      accountId: asanaFixtureAccount.accountId,
      resourceScopeHash: 'c'.repeat(64),
      kind: 'cursor',
      encryptedCursor: 'sync-token-a',
      checkpointEpoch: 1,
      adapterVersion: asanaWorkManagementConnectorDescriptor.descriptorVersion,
      sourceWatermark: 'sync-token-a',
      lastCompletePage: 0,
      status: 'active',
      committedAt: ASANA_FIXTURE_NOW,
    },
    expectedCheckpointEpoch: 1,
    adapterVersion: asanaWorkManagementConnectorDescriptor.descriptorVersion,
    maxPages,
    maxItems,
  });
}

function subscriptionRequest() {
  return subscriptionMutationRequestSchema.parse({
    schemaVersion: '1',
    account: accountRef(),
    resourceScopeHash: 'c'.repeat(64),
    expectedLeaseEpoch: 1,
    mutationClaim: {
      tenantId: asanaFixtureAccount.tenantId,
      accountId: asanaFixtureAccount.accountId,
      resourceScopeHash: 'c'.repeat(64),
      leaseEpoch: 1,
      mutationEpoch: 1,
      requestFingerprint: 'd'.repeat(64),
      owner: 'fixture-worker',
      expiresAt: '2026-07-17T13:00:00.000Z',
      mutation: 'create',
    },
    expectedClaimRequestFingerprint: 'd'.repeat(64),
    expectedMutation: 'create',
    providerIdempotencyKey: 'webhook-create-a',
    requestedExpiresAt: '2026-07-18T12:00:00.000Z',
  });
}

function rawWebhook(
  body: unknown,
  headers: Record<string, string>,
): RawWebhookRequest {
  return rawWebhookRequestSchema.parse({
    method: 'POST',
    providerVisibleUrl: 'https://example.invalid/hooks/asana',
    headers,
    rawBodyBase64: Buffer.from(JSON.stringify(body)).toString('base64'),
    receivedAt: ASANA_FIXTURE_NOW,
  });
}

describe('Asana WorkManagementConnector', () => {
  it('exposes immutable OAuth metadata and a PKCE authorization request', async () => {
    const connector = new AsanaWorkManagementConnector(
      options(new ProviderShapedTransport()),
    );
    expect(Object.isFrozen(connector.descriptor())).toBe(true);
    expect(connector.descriptor()).not.toHaveProperty('channel');
    expect(connector.authorizationStrategy()).toEqual({
      strategy: 'oauth',
      audience: 'asana-api',
      scopes: ['default'],
    });
    const input = authorizationInputSchema.parse({
      schemaVersion: '1',
      tenantId: 'tenant-a',
      userId: 'user-a',
      connectorId: 'asana-work-management',
      redirectUri: 'https://example.invalid/oauth/asana/callback',
      stateDigest: 'a'.repeat(64),
      pkceChallenge: 'p'.repeat(43),
      requestedScopes: ['default'],
    });
    const start = await connector.beginAuthorization(input);
    const url = new URL(start.authorizationUrl);
    expect(url.origin).toBe('https://app.asana.com');
    expect(url.searchParams.get('state')).toBe(input.stateDigest);
    expect(url.searchParams.get('code_challenge')).toBe(input.pkceChallenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('passes the reusable work-management connector contract', async () => {
    const transport = new ProviderShapedTransport();
    const connector = createAsanaWorkManagementConnector(options(transport));
    const base = createConnectorContractFixtures();
    const artifact = effectExecutionArtifactSchema.parse(
      asanaFixtureArtifact(asanaFixtureUpdatePayload),
    );
    const fixtures = {
      ...base,
      snapshot: asanaFixtureSnapshot,
      account: asanaFixtureAccount,
      accountRef: accountRef(),
      artifact,
      reconcileRequest: reconcileSendRequestSchema.parse({
        schemaVersion: '1',
        artifact,
        priorAttemptId: artifact.attemptId,
        strategy: artifact.reconciliationStrategy,
        strategyVersion: artifact.reconciliationStrategyVersion,
        maxProviderQueries: 2,
      }),
      pollRequest: pollRequest(),
      subscriptionRequest: subscriptionRequest(),
    };
    const report = await runWorkManagementConnectorContract(
      connector,
      fixtures,
    );
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('retrieves scoped task, project, milestone, and comment facts', async () => {
    const connector = new AsanaWorkManagementConnector(
      options(new ProviderShapedTransport()),
    );
    for (const ref of [
      { kind: 'task' as const, providerObjectId: 'task-a' },
      { kind: 'project' as const, providerObjectId: 'project-a' },
      { kind: 'milestone' as const, providerObjectId: 'milestone-a' },
      { kind: 'comment' as const, providerObjectId: 'comment-a' },
    ]) {
      const fact = await connector.fetchObject(asanaFixtureAccount, ref);
      expect(fact.kind).toBe(ref.kind);
      expect(fact.providerObjectId).toBe(ref.providerObjectId);
      expect(fact.payloadFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it('fails closed when a provider object is outside the configured scope', async () => {
    const transport = new ProviderShapedTransport(() =>
      providerResponse(200, {
        data: {
          ...asanaFixtureTask.data,
          workspace: { gid: 'workspace-other' },
          memberships: [{ project: { gid: 'project-other' } }],
        },
      }),
    );
    const connector = new AsanaWorkManagementConnector(options(transport));
    await expect(
      connector.fetchObject(asanaFixtureAccount, {
        kind: 'task',
        providerObjectId: 'task-a',
      }),
    ).rejects.toThrow('ASANA_TASK_SCOPE_REJECTED');
  });

  it('requires workspace and configured-project scope independently', async () => {
    const sameWorkspaceWrongProject = new AsanaWorkManagementConnector(
      options(
        new ProviderShapedTransport(() =>
          providerResponse(200, {
            data: {
              ...asanaFixtureTask.data,
              workspace: { gid: 'workspace-a' },
              memberships: [{ project: { gid: 'project-other' } }],
            },
          }),
        ),
      ),
    );
    await expect(
      sameWorkspaceWrongProject.fetchObject(asanaFixtureAccount, {
        kind: 'task',
        providerObjectId: 'task-a',
      }),
    ).rejects.toThrow('ASANA_TASK_SCOPE_REJECTED');

    const wrongWorkspaceAllowedProject = new AsanaWorkManagementConnector(
      options(
        new ProviderShapedTransport(() =>
          providerResponse(200, {
            data: {
              ...asanaFixtureTask.data,
              workspace: { gid: 'workspace-other' },
              memberships: [{ project: { gid: 'project-a' } }],
            },
          }),
        ),
      ),
    );
    await expect(
      wrongWorkspaceAllowedProject.fetchObject(asanaFixtureAccount, {
        kind: 'task',
        providerObjectId: 'task-a',
      }),
    ).rejects.toThrow('ASANA_TASK_SCOPE_REJECTED');

    const projectNotAllowlisted = new AsanaWorkManagementConnector(
      options(
        new ProviderShapedTransport(() =>
          providerResponse(200, {
            data: {
              ...asanaFixtureProject.data,
              gid: 'project-other',
              workspace: { gid: 'workspace-a' },
            },
          }),
        ),
      ),
    );
    await expect(
      projectNotAllowlisted.fetchObject(asanaFixtureAccount, {
        kind: 'project',
        providerObjectId: 'project-other',
      }),
    ).rejects.toThrow('ASANA_PROJECT_SCOPE_REJECTED');
  });

  it('bounds pagination, preserves the next sync token, and never retries 429', async () => {
    let page = 0;
    const transport = new ProviderShapedTransport((request) => {
      if (request.path !== '/events') return defaultRoute(request);
      page += 1;
      return providerResponse(200, {
        data: [
          {
            action: 'changed',
            resource: { gid: `task-${page}`, resource_type: 'task' },
            created_at: ASANA_FIXTURE_NOW,
          },
        ],
        sync: `sync-token-${page}`,
        next_page: { offset: `offset-${page}` },
      });
    });
    const connector = new AsanaWorkManagementConnector(options(transport));
    const result = await connector.poll(accountRef(), pollRequest(2, 10));
    expect(result.complete).toBe(false);
    expect(result.envelopes).toHaveLength(2);
    expect(result.nextEncryptedCursor).toBe('sync-token-2');
    expect(
      result.envelopes.every(
        (envelope) =>
          envelope.connectorSnapshot.runtimeMode === 'virtual_test' &&
          envelope.connectorSnapshot.accountId ===
            asanaFixtureSnapshot.accountId,
      ),
    ).toBe(true);
    expect(page).toBe(2);

    const limited = new ProviderShapedTransport(() =>
      providerResponse(
        429,
        { errors: [{ message: 'Rate limit enforced' }] },
        {
          'retry-after': '37',
        },
      ),
    );
    const limitedConnector = new AsanaWorkManagementConnector(options(limited));
    await expect(
      limitedConnector.poll(accountRef(), pollRequest()),
    ).rejects.toMatchObject({
      name: 'AsanaRateLimitError',
      retryAfterSeconds: 37,
    } satisfies Partial<AsanaRateLimitError>);
    expect(limited.requests).toHaveLength(1);
  });

  it('rejects account or artifact snapshot substitution before provider I/O', async () => {
    const transport = new ProviderShapedTransport();
    const connector = new AsanaWorkManagementConnector(options(transport));
    await expect(
      connector.poll(
        connectorAccountRefSchema.parse({
          ...accountRef(),
          accountId: 'asana-account-other',
        }),
        pollRequest(),
      ),
    ).rejects.toThrow('ASANA_ACCOUNT_SNAPSHOT_MISMATCH');

    await expect(
      connector.execute(accountRef(), {
        ...asanaFixtureArtifact(asanaFixtureUpdatePayload),
        connectorSnapshot: {
          ...asanaFixtureSnapshot,
          runtimeMode: 'live',
        },
      }),
    ).rejects.toThrow('ASANA_EFFECT_ARTIFACT_BINDING_MISMATCH');
    expect(transport.requests).toHaveLength(0);
  });

  it('verifies handshake and HMAC, records heartbeats, and refetches compact events', async () => {
    const connector = new AsanaWorkManagementConnector(
      options(new ProviderShapedTransport()),
    );
    const handshake = rawWebhookRequestSchema.parse({
      method: 'POST',
      providerVisibleUrl: 'https://example.invalid/hooks/asana',
      headers: { 'X-Hook-Secret': 'provider-challenge' },
      rawBodyBase64: 'e30=',
      receivedAt: ASANA_FIXTURE_NOW,
    });
    expect(connector.verifyWebhook(handshake)).toEqual({
      kind: 'handshake',
      responseHeaders: { 'x-hook-secret': 'provider-challenge' },
    });

    const heartbeatBody = { events: [] };
    const heartbeatRaw = Buffer.from(JSON.stringify(heartbeatBody));
    const heartbeat = rawWebhook(heartbeatBody, {
      'X-Hook-Signature': createHmac(
        'sha256',
        ['fixture', 'webhook', 'key'].join('-'),
      )
        .update(heartbeatRaw)
        .digest('hex'),
    });
    expect(connector.verifyWebhook(heartbeat)).toMatchObject({
      kind: 'verified_events',
      events: [],
      heartbeatAt: ASANA_FIXTURE_NOW,
    });

    const eventBody = {
      events: [
        {
          action: 'changed',
          resource: {
            gid: 'task-a',
            resource_type: 'task',
            resource_subtype: 'default_task',
          },
          user: { gid: 'user-asana-a', resource_type: 'user' },
          created_at: ASANA_FIXTURE_NOW,
        },
      ],
    };
    const eventRaw = Buffer.from(JSON.stringify(eventBody));
    const verified = connector.verifyWebhook(
      rawWebhook(eventBody, {
        'X-Hook-Signature': createHmac(
          'sha256',
          ['fixture', 'webhook', 'key'].join('-'),
        )
          .update(eventRaw)
          .digest('hex'),
      }),
    );
    expect(verified.kind).toBe('verified_events');
    if (verified.kind !== 'verified_events') throw new Error('expected events');
    expect(verified.events).toHaveLength(1);
    const fact = await connector.fetchWebhookEvent(
      asanaFixtureAccount,
      verified.events[0]!,
    );
    expect(fact.providerObjectId).toBe('task-a');

    expect(
      connector.verifyWebhook(
        rawWebhook(eventBody, { 'X-Hook-Signature': '0'.repeat(64) }),
      ),
    ).toEqual({ kind: 'rejected', reasonCode: 'signature_invalid' });
  });

  it('creates, updates, and comments only through a fingerprint-bound artifact', async () => {
    const cases: ReadonlyArray<{
      payload: AsanaEffectPayload;
      expectedGid: string;
      expectedMethod: string;
      expectedPath: string;
    }> = [
      {
        payload: {
          kind: 'create_task',
          workspaceGid: 'workspace-a',
          projectGid: 'project-a',
          fields: { name: 'Follow up with finance', dueOn: '2026-07-20' },
        },
        expectedGid: 'task-returned-a',
        expectedMethod: 'POST',
        expectedPath: '/tasks',
      },
      {
        payload: asanaFixtureUpdatePayload,
        expectedGid: 'task-a',
        expectedMethod: 'PUT',
        expectedPath: '/tasks/task-a',
      },
      {
        payload: {
          kind: 'create_comment',
          taskGid: 'task-a',
          text: 'Linked from communication action plan.',
          precondition: { modifiedAt: ASANA_FIXTURE_NOW },
        },
        expectedGid: 'comment-returned-a',
        expectedMethod: 'POST',
        expectedPath: '/tasks/task-a/stories',
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const transport = new ProviderShapedTransport();
      const connector = new AsanaWorkManagementConnector(
        options(transport, testCase.payload),
      );
      const artifact = asanaFixtureArtifact(
        testCase.payload,
        `asana-operation-${index}`,
      );
      const result = await connector.execute(accountRef(), artifact);
      expect(result).toMatchObject({
        outcome: 'accepted',
        providerCorrelation: testCase.expectedGid,
      });
      expect(
        transport.requests.some(
          (request) =>
            request.method === testCase.expectedMethod &&
            request.path === testCase.expectedPath &&
            request.operationId === artifact.stableIdempotencyKey,
        ),
      ).toBe(true);
    }

    const mismatched = new AsanaWorkManagementConnector(
      options(new ProviderShapedTransport(), asanaFixtureUpdatePayload),
    );
    await expect(
      mismatched.execute(accountRef(), {
        ...asanaFixtureArtifact(asanaFixtureUpdatePayload),
        renderedPayloadFingerprint: 'f'.repeat(64),
      }),
    ).rejects.toThrow('ASANA_EFFECT_PAYLOAD_FINGERPRINT_MISMATCH');
  });

  it('rejects creates without an allowed project before provider I/O', async () => {
    for (const [operationId, payload] of [
      [
        'create-without-project',
        {
          kind: 'create_task' as const,
          workspaceGid: 'workspace-a',
          fields: { name: 'Missing project scope' },
        },
      ],
      [
        'create-disallowed-project',
        {
          kind: 'create_task' as const,
          workspaceGid: 'workspace-a',
          projectGid: 'project-other',
          fields: { name: 'Wrong project scope' },
        },
      ],
    ] satisfies ReadonlyArray<readonly [string, AsanaEffectPayload]>) {
      const transport = new ProviderShapedTransport();
      const connector = new AsanaWorkManagementConnector(
        options(transport, payload),
      );
      await expect(
        connector.execute(
          accountRef(),
          asanaFixtureArtifact(payload, operationId),
        ),
      ).rejects.toThrow('ASANA_EFFECT_SCOPE_REJECTED');
      expect(
        transport.requests.filter((request) => request.method === 'POST'),
      ).toHaveLength(0);
    }
  });

  it('rejects stale preconditions and freezes ambiguous create/update without ordinary retry', async () => {
    const staleTransport = new ProviderShapedTransport((request) => {
      if (request.method === 'GET' && request.path === '/tasks/task-a') {
        return providerResponse(200, {
          data: { ...asanaFixtureTask.data, modified_at: ASANA_FIXTURE_LATER },
        });
      }
      return defaultRoute(request);
    });
    const stale = new AsanaWorkManagementConnector(
      options(staleTransport, asanaFixtureUpdatePayload),
    );
    await expect(
      stale.execute(
        accountRef(),
        asanaFixtureArtifact(asanaFixtureUpdatePayload),
      ),
    ).rejects.toThrow('ASANA_PRECONDITION_STALE');
    expect(
      staleTransport.requests.filter((request) => request.method === 'PUT'),
    ).toHaveLength(0);

    const ambiguousUpdateTransport = new ProviderShapedTransport((request) =>
      request.method === 'PUT' && request.path === '/tasks/task-a'
        ? providerResponse(503, {
            errors: [{ message: 'Update outcome unavailable' }],
          })
        : defaultRoute(request),
    );
    const ambiguousUpdate = new AsanaWorkManagementConnector(
      options(ambiguousUpdateTransport, asanaFixtureUpdatePayload),
    );
    await expect(
      ambiguousUpdate.execute(
        accountRef(),
        asanaFixtureArtifact(asanaFixtureUpdatePayload, 'ambiguous-update'),
      ),
    ).resolves.toMatchObject({
      outcome: 'acceptance_unknown',
      reasonCode: 'http_503_outcome_unknown',
    });
    expect(
      ambiguousUpdateTransport.requests.filter(
        (request) => request.method === 'PUT',
      ),
    ).toHaveLength(1);

    const createPayload: AsanaEffectPayload = {
      kind: 'create_task',
      workspaceGid: 'workspace-a',
      projectGid: 'project-a',
      fields: { name: 'Ambiguous create' },
    };
    const ambiguousTransport = new ProviderShapedTransport((request) =>
      request.path === '/tasks' && request.method === 'POST'
        ? providerResponse(503, {
            errors: [{ message: 'Outcome unavailable' }],
          })
        : defaultRoute(request),
    );
    const connector = createAsanaWorkManagementConnector(
      options(ambiguousTransport, createPayload),
    );
    const artifact = effectExecutionArtifactSchema.parse(
      asanaFixtureArtifact(createPayload, 'ambiguous-create'),
    );
    const persistence = new InMemoryEffectPersistence();
    const authority = new ExactFixtureArtifactAuthority(artifact);
    const first = await dispatchWorkManagementEffect(
      connector,
      persistence,
      authority,
      accountRef(),
      artifact,
      asanaFixtureSnapshot,
    );
    expect(first.status).toBe('reconciliation_required');
    expect(first.attempt.transportState).toBe('acceptance_unknown');
    await expect(
      dispatchWorkManagementEffect(
        connector,
        persistence,
        authority,
        accountRef(),
        artifact,
        asanaFixtureSnapshot,
      ),
    ).rejects.toBeInstanceOf(UnknownAcceptanceRetryError);
    expect(
      ambiguousTransport.requests.filter(
        (request) => request.path === '/tasks' && request.method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('returns heartbeat-linked subscription facts without replacing the webhook', async () => {
    const transport = new ProviderShapedTransport();
    const connector = new AsanaWorkManagementConnector(options(transport));
    const created = await connector.subscribe(
      accountRef(),
      subscriptionRequest(),
    );
    expect(created.providerReference).toBe('webhook-a');
    const renewed = await connector.renewSubscription(
      accountRef(),
      subscriptionRequest(),
    );
    expect(renewed.providerReference).toBe('webhook-a');
    expect(
      transport.requests.filter(
        (request) => request.path === '/webhooks' && request.method === 'POST',
      ),
    ).toHaveLength(1);
  });
});
