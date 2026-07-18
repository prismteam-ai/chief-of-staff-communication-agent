import { describe, expect, it } from 'vitest';

import {
  AsanaAcceptanceError,
  runAsanaAcceptance,
  validateControlledAuthorization,
  type AsanaControlledAuthorization,
} from './acceptance.js';
import {
  parseAsanaAcceptanceCli,
  parseAsanaPatEnv,
  parseControlledAuthorization,
  runAsanaAcceptanceCli,
} from './acceptance-cli.js';
import type {
  AsanaEffectPayload,
  AsanaRequest,
  AsanaResponse,
  AsanaTransport,
} from './types.js';

const NOW = '2026-07-18T12:00:00.000Z';
const WORKSPACE = '1001';
const PROJECT = '2001';
const MARKER = 'chief_asana_assessment_0001';

function authorization(marker = MARKER): AsanaControlledAuthorization {
  return {
    schemaVersion: '1',
    kind: 'asana_controlled_assessment_authorization',
    authorizationId: 'authorization_0001',
    workspaceGid: WORKSPACE,
    projectGid: PROJECT,
    assessmentMarker: marker,
    authorizedOperations: ['create_task', 'update_task'],
    expiresAt: '2026-07-19T12:00:00.000Z',
  };
}

function response(
  status: number,
  body: unknown,
  requestId = 'request-1',
): AsanaResponse {
  return {
    status,
    headers: { 'x-request-id': requestId, 'content-type': 'application/json' },
    body,
  };
}

function projectBody() {
  return {
    data: {
      gid: PROJECT,
      resource_type: 'project',
      name: 'private-name-not-evidence',
      modified_at: NOW,
      workspace: { gid: WORKSPACE },
    },
  };
}

function taskBody(gid: string, name: string, modifiedAt = NOW) {
  return {
    data: {
      gid,
      resource_type: 'task',
      resource_subtype: 'default_task',
      name,
      modified_at: modifiedAt,
      workspace: { gid: WORKSPACE },
      memberships: [{ project: { gid: PROJECT } }],
    },
  };
}

class AcceptanceFixtureTransport implements AsanaTransport {
  public readonly requests: AsanaRequest[] = [];
  public workspaceGids = [WORKSPACE];
  public tasks: Array<{ gid: string; name: string; modifiedAt: string }> = [];
  public nextTaskOffset: string | undefined;
  public ambiguousCreate: 'none' | 'accepted_on_reconcile' | 'unknown' = 'none';
  public reconciliations = 0;
  public createdReadNameOverride: string | undefined;
  public updatedReadNameOverride: string | undefined;
  public omitTaskNames = false;

  public request(request: AsanaRequest): Promise<AsanaResponse> {
    this.requests.push(request);
    if (request.path === '/users/me') {
      return Promise.resolve(
        response(200, {
          data: {
            gid: '3001',
            workspaces: this.workspaceGids.map((gid) => ({ gid })),
          },
        }),
      );
    }
    if (request.path === `/workspaces/${WORKSPACE}/projects`) {
      return Promise.resolve(
        response(200, { data: [{ gid: PROJECT }], next_page: null }),
      );
    }
    if (request.path === `/projects/${PROJECT}/tasks`) {
      return Promise.resolve(
        response(200, {
          data: this.tasks.map((task) => ({
            gid: task.gid,
            ...(this.omitTaskNames ? {} : { name: task.name }),
            modified_at: task.modifiedAt,
          })),
          next_page:
            this.nextTaskOffset === undefined
              ? null
              : { offset: this.nextTaskOffset },
        }),
      );
    }
    if (request.path === `/projects/${PROJECT}`) {
      return Promise.resolve(response(200, projectBody()));
    }
    if (request.path.startsWith('/tasks/') && request.method === 'GET') {
      const taskGid = request.path.slice('/tasks/'.length);
      const task = this.tasks.find(({ gid }) => gid === taskGid);
      if (task === undefined)
        return Promise.resolve(response(404, { errors: [] }));
      const isUpdated = task.name.endsWith('controlled task verified');
      const observedName = isUpdated
        ? (this.updatedReadNameOverride ?? task.name)
        : (this.createdReadNameOverride ?? task.name);
      return Promise.resolve(
        response(200, taskBody(task.gid, observedName, task.modifiedAt)),
      );
    }
    if (request.path === '/tasks' && request.method === 'POST') {
      const body = request.body as { data: { name: string } };
      this.tasks.push({ gid: '9001', name: body.data.name, modifiedAt: NOW });
      if (this.ambiguousCreate !== 'none') {
        return Promise.reject(new Error('synthetic ambiguous transport'));
      }
      return Promise.resolve(response(201, { data: { gid: '9001' } }));
    }
    if (request.path === '/tasks/9001' && request.method === 'PUT') {
      const body = request.body as { data: { name: string } };
      this.tasks[0] = {
        gid: '9001',
        name: body.data.name,
        modifiedAt: '2026-07-18T12:01:00.000Z',
      };
      return Promise.resolve(response(200, { data: { gid: '9001' } }));
    }
    return Promise.resolve(response(404, { errors: [] }));
  }

  public reconcileEffect(
    _account: unknown,
    _artifact: unknown,
    payload: AsanaEffectPayload,
  ) {
    this.reconciliations += 1;
    if (
      payload.kind === 'create_task' &&
      this.ambiguousCreate === 'accepted_on_reconcile'
    ) {
      return Promise.resolve({
        outcome: 'accepted' as const,
        gid: '9001',
        response: { status: 200, gid: '9001' },
      });
    }
    return Promise.resolve({
      outcome: 'unknown' as const,
      reasonCode: 'synthetic_acceptance_ambiguous',
    });
  }
}

describe('Asana live acceptance', () => {
  it('parses the existing dotenv shape without exposing or executing values', () => {
    const synthetic = [
      '# controlled fixture',
      'ASANA_LOGIN_EMAIL="operator@example.invalid"',
      'ASANA_PAT="synthetic_pat_value"',
      'ASANA_LOGIN_PASSWORD=ignored-not-used',
    ].join('\n');
    expect(parseAsanaPatEnv(synthetic)).toBe('synthetic_pat_value');
    for (const malformed of [
      'ASANA_PAT',
      'ASANA_PAT=',
      'ASANA_PAT=one\nASANA_PAT=two',
      'ASANA_PAT="unterminated',
      'ASANA_PAT="line\\nfeed"',
      `ASANA_PAT=${'x'.repeat(4_097)}`,
      `${'#'.repeat(65_537)}\nASANA_PAT=synthetic_pat_value`,
    ]) {
      expect(() => parseAsanaPatEnv(malformed)).toThrow(
        'ASANA_ACCEPTANCE_CREDENTIAL_INVALID',
      );
    }
  });

  it('requires the mutation flag, exact GIDs, marker, and authorization path together', () => {
    expect(
      parseAsanaAcceptanceCli([
        '--credential-file',
        '.config/asana.env',
        '--workspace-gid',
        WORKSPACE,
        '--project-gid',
        PROJECT,
      ]),
    ).toMatchObject({ allowControlledMutation: false });
    expect(() =>
      parseAsanaAcceptanceCli([
        '--credential-file',
        '.config/asana.env',
        '--allow-controlled-mutation',
        '--workspace-gid',
        WORKSPACE,
        '--project-gid',
        PROJECT,
      ]),
    ).toThrow('ASANA_ACCEPTANCE_ARGUMENT_INVALID');
  });

  it('strictly parses and prevalidates the local authorization record', () => {
    const parsed = parseControlledAuthorization(
      JSON.stringify(authorization()),
    );
    expect(parsed).toEqual(authorization());
    expect(() =>
      parseControlledAuthorization(
        JSON.stringify({ ...authorization(), unexpected: true }),
      ),
    ).toThrow('ASANA_ACCEPTANCE_AUTHORIZATION_INVALID');
    expect(() =>
      parseControlledAuthorization(
        JSON.stringify({
          ...authorization(),
          authorizationId: 'a'.repeat(17_000),
        }),
      ),
    ).toThrow('ASANA_ACCEPTANCE_AUTHORIZATION_INVALID');
    expect(() =>
      validateControlledAuthorization(
        { ...authorization(), expiresAt: NOW },
        WORKSPACE,
        PROJECT,
        NOW,
      ),
    ).toThrow('ASANA_ACCEPTANCE_AUTHORIZATION_EXPIRED');
    expect(() =>
      validateControlledAuthorization(authorization(), WORKSPACE, '9999', NOW),
    ).toThrow('ASANA_ACCEPTANCE_AUTHORIZATION_MISMATCH');
  });

  it('rejects expired authorization before credential transport construction or provider I/O', async () => {
    let transportConstructions = 0;
    let acceptanceRuns = 0;
    const output: string[] = [];
    const exitCode = await runAsanaAcceptanceCli(
      [
        '--credential-file',
        '.config/not-read.env',
        '--workspace-gid',
        WORKSPACE,
        '--project-gid',
        PROJECT,
        '--allow-controlled-mutation',
        '--authorization-file',
        '.config/synthetic-authorization.json',
        '--assessment-marker',
        MARKER,
      ],
      {
        now: () => NOW,
        readAuthorizationFile: () =>
          Promise.resolve(
            JSON.stringify({ ...authorization(), expiresAt: NOW }),
          ),
        createTransport: () => {
          transportConstructions += 1;
          throw new Error('must not construct transport');
        },
        runAcceptance: () => {
          acceptanceRuns += 1;
          return Promise.reject(new Error('must not run acceptance'));
        },
        writeOutput: (value) => output.push(value),
      },
    );
    expect(exitCode).toBe(1);
    expect(transportConstructions).toBe(0);
    expect(acceptanceRuns).toBe(0);
    expect(output.join('')).toContain('ASANA_ACCEPTANCE_AUTHORIZATION_EXPIRED');
    expect(output.join('')).not.toContain('.config/not-read.env');
  });

  it('enumerates bounded choices or emits selected scope read evidence through the connector', async () => {
    const transport = new AcceptanceFixtureTransport();
    transport.tasks = [
      { gid: '4001', name: 'private task name', modifiedAt: NOW },
    ];
    const selection = await runAsanaAcceptance({
      transport,
      transportEvidence: [],
      now: () => NOW,
    });
    expect(selection).toMatchObject({
      status: 'selection_required',
      choices: { workspaceGids: [WORKSPACE], projectGids: [] },
    });

    const report = await runAsanaAcceptance({
      transport,
      transportEvidence: [],
      workspaceGid: WORKSPACE,
      projectGid: PROJECT,
      maxItems: 5,
      maxPages: 2,
      now: () => NOW,
    });
    expect(report).toMatchObject({
      status: 'pass',
      observed: { taskCount: 1, connectorFactCount: 2, complete: true },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('private task name');
    expect(serialized).not.toContain('private-name-not-evidence');
  });

  it('bounds workspace discovery without rejecting an exact GID beyond the emitted choices', async () => {
    const transport = new AcceptanceFixtureTransport();
    transport.workspaceGids = ['1000', WORKSPACE];
    const report = await runAsanaAcceptance({
      transport,
      transportEvidence: [],
      workspaceGid: WORKSPACE,
      projectGid: PROJECT,
      maxItems: 1,
      now: () => NOW,
    });
    expect(report).toMatchObject({
      status: 'pass',
      choices: { workspaceGids: ['1000'] },
      observed: { workspaceCount: 1, complete: false },
    });
  });

  it('rejects provider identifiers that are not bounded numeric GIDs', async () => {
    const workspace = new AcceptanceFixtureTransport();
    workspace.workspaceGids = ['operator@example.invalid'];
    await expect(
      runAsanaAcceptance({
        transport: workspace,
        transportEvidence: [],
        now: () => NOW,
      }),
    ).rejects.toThrow('ASANA_ACCEPTANCE_RESPONSE_INVALID');

    const task = new AcceptanceFixtureTransport();
    task.tasks = [
      {
        gid: 'operator@example.invalid',
        name: 'not evidence',
        modifiedAt: NOW,
      },
    ];
    await expect(
      runAsanaAcceptance({
        transport: task,
        transportEvidence: [],
        workspaceGid: WORKSPACE,
        projectGid: PROJECT,
        now: () => NOW,
      }),
    ).rejects.toThrow('ASANA_ACCEPTANCE_RESPONSE_INVALID');
  });

  it('fails before creation on a duplicate marker or incomplete project enumeration', async () => {
    const duplicate = new AcceptanceFixtureTransport();
    duplicate.tasks = [
      { gid: '4001', name: `existing ${MARKER}`, modifiedAt: NOW },
    ];
    await expect(
      runAsanaAcceptance({
        transport: duplicate,
        transportEvidence: [],
        workspaceGid: WORKSPACE,
        projectGid: PROJECT,
        mutationAuthorization: authorization(),
        now: () => NOW,
      }),
    ).rejects.toThrow('ASANA_ACCEPTANCE_DUPLICATE_MARKER');
    expect(
      duplicate.requests.filter(({ method }) => method === 'POST'),
    ).toEqual([]);
    expect(
      duplicate.requests.find(
        ({ path }) => path === `/projects/${PROJECT}/tasks`,
      )?.query,
    ).toMatchObject({ completed_since: '1970-01-01T00:00:00.000Z' });

    const incomplete = new AcceptanceFixtureTransport();
    incomplete.nextTaskOffset = 'more-tasks-exist';
    await expect(
      runAsanaAcceptance({
        transport: incomplete,
        transportEvidence: [],
        workspaceGid: WORKSPACE,
        projectGid: PROJECT,
        maxPages: 1,
        mutationAuthorization: authorization(),
        now: () => NOW,
      }),
    ).rejects.toThrow('ASANA_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN');
    expect(
      incomplete.requests.filter(({ method }) => method === 'POST'),
    ).toEqual([]);

    const nameless = new AcceptanceFixtureTransport();
    nameless.tasks = [
      { gid: '4002', name: 'provider omitted this name', modifiedAt: NOW },
    ];
    nameless.omitTaskNames = true;
    await expect(
      runAsanaAcceptance({
        transport: nameless,
        transportEvidence: [],
        workspaceGid: WORKSPACE,
        projectGid: PROJECT,
        mutationAuthorization: authorization(),
        now: () => NOW,
      }),
    ).rejects.toThrow('ASANA_ACCEPTANCE_RESPONSE_INVALID');
    expect(nameless.requests.filter(({ method }) => method === 'POST')).toEqual(
      [],
    );
  });

  it('rejects unsafe injected request metadata before evidence emission', async () => {
    for (const unsafe of [
      {
        method: 'GET',
        status: 200,
        requestId: 'operator@example.invalid',
      },
      { method: 'GET', status: 200, rawBody: 'private provider body' },
      { method: 'GET', status: 200, retryAfterSeconds: 3 },
    ]) {
      await expect(
        runAsanaAcceptance({
          transport: new AcceptanceFixtureTransport(),
          transportEvidence: [unsafe as never],
          now: () => NOW,
        }),
      ).rejects.toThrow('ASANA_ACCEPTANCE_RESPONSE_INVALID');
    }
  });

  it('creates and precondition-updates only through immutable connector-core artifacts', async () => {
    const transport = new AcceptanceFixtureTransport();
    const report = await runAsanaAcceptance({
      transport,
      transportEvidence: [],
      workspaceGid: WORKSPACE,
      projectGid: PROJECT,
      mutationAuthorization: authorization(),
      now: () => NOW,
    });
    expect(report.mutation).toMatchObject({
      taskGid: '9001',
      createOutcome: 'accepted',
      updateOutcome: 'accepted',
      reconciledReadCount: 2,
    });
    expect(
      transport.requests.filter(
        ({ method, path }) => method === 'POST' && path === '/tasks',
      ),
    ).toHaveLength(1);
    const update = transport.requests.find(
      ({ method, path }) => method === 'PUT' && path === '/tasks/9001',
    );
    expect(update?.operationId).toMatch(/^asana-assessment-update-/u);
    expect(update?.headers).toEqual({ 'if-unmodified-since': NOW });
    expect(JSON.stringify(report)).not.toContain(MARKER);
  });

  it('fails closed when either post-effect read-back differs from the exact approved name', async () => {
    const createMismatch = new AcceptanceFixtureTransport();
    createMismatch.createdReadNameOverride = 'provider returned another name';
    await expect(
      runAsanaAcceptance({
        transport: createMismatch,
        transportEvidence: [],
        workspaceGid: WORKSPACE,
        projectGid: PROJECT,
        mutationAuthorization: authorization(),
        now: () => NOW,
      }),
    ).rejects.toThrow('ASANA_ACCEPTANCE_RESPONSE_INVALID');
    expect(
      createMismatch.requests.filter(({ method }) => method === 'PUT'),
    ).toHaveLength(0);

    const updateMismatch = new AcceptanceFixtureTransport();
    updateMismatch.updatedReadNameOverride = 'provider returned another name';
    await expect(
      runAsanaAcceptance({
        transport: updateMismatch,
        transportEvidence: [],
        workspaceGid: WORKSPACE,
        projectGid: PROJECT,
        mutationAuthorization: authorization(),
        now: () => NOW,
      }),
    ).rejects.toThrow('ASANA_ACCEPTANCE_RESPONSE_INVALID');
    expect(
      updateMismatch.requests.filter(({ method }) => method === 'PUT'),
    ).toHaveLength(1);
  });

  it('reconciles ambiguous acceptance without resending and freezes unresolved outcomes', async () => {
    const reconciled = new AcceptanceFixtureTransport();
    reconciled.ambiguousCreate = 'accepted_on_reconcile';
    await expect(
      runAsanaAcceptance({
        transport: reconciled,
        transportEvidence: [],
        workspaceGid: WORKSPACE,
        projectGid: PROJECT,
        mutationAuthorization: authorization(),
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ status: 'pass' });
    expect(reconciled.reconciliations).toBe(1);
    expect(
      reconciled.requests.filter(
        ({ method, path }) => method === 'POST' && path === '/tasks',
      ),
    ).toHaveLength(1);

    const frozen = new AcceptanceFixtureTransport();
    frozen.ambiguousCreate = 'unknown';
    await expect(
      runAsanaAcceptance({
        transport: frozen,
        transportEvidence: [],
        workspaceGid: WORKSPACE,
        projectGid: PROJECT,
        mutationAuthorization: authorization(),
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(AsanaAcceptanceError);
    expect(
      frozen.requests.filter(
        ({ method, path }) => method === 'POST' && path === '/tasks',
      ),
    ).toHaveLength(1);
  });
});
