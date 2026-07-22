import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  AsanaRestTransport,
  AsanaWorkManagementConnector,
  createAsanaLiveComposition,
} from './index.js';
import {
  ASANA_FIXTURE_NOW,
  asanaFixtureAccount,
  asanaFixtureSnapshot,
  asanaFixtureUpdatePayload,
} from './provider-fixtures.js';

describe('@chief/work-management-asana exports', () => {
  it('exports production transport/composition/connector without fixture resolution', async () => {
    expect(AsanaRestTransport).toBeTypeOf('function');
    expect(AsanaWorkManagementConnector).toBeTypeOf('function');
    expect(createAsanaLiveComposition).toBeTypeOf('function');
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { readonly exports?: Readonly<Record<string, unknown>> };
    expect(Object.keys(packageJson.exports ?? {}).sort()).toEqual([
      '.',
      './acceptance',
      './acceptance-cli',
    ]);
    expect(packageJson.exports).not.toHaveProperty('./*');
    expect(JSON.stringify(packageJson.exports)).not.toContain(
      'provider-fixtures',
    );
    expect(JSON.stringify(packageJson.exports)).not.toContain('.test');

    const rootSpecifier = '@chief/work-management-asana';
    const acceptanceSpecifier = '@chief/work-management-asana/acceptance';
    await expect(import(rootSpecifier)).resolves.toHaveProperty(
      'createAsanaLiveComposition',
    );
    await expect(import(acceptanceSpecifier)).resolves.toHaveProperty(
      'runAsanaAcceptance',
    );
    for (const forbidden of [
      '@chief/work-management-asana/provider-fixtures',
      '@chief/work-management-asana/connector.test',
      '@chief/work-management-asana/canonical',
    ]) {
      await expect(import(forbidden)).rejects.toBeDefined();
    }
  });

  it('requires a live snapshot and rejects runtime fetch authority smuggling', () => {
    let injectedFetchCalls = 0;
    const shared = {
      clientId: 'client-a',
      scope: {
        workspaceGid: 'workspace-a',
        projectGids: ['project-a'],
        pollingResourceGids: ['project-a'],
      },
      authorization: {
        completeAuthorization: () => Promise.resolve(asanaFixtureAccount),
      },
      effectPayloads: {
        loadExactPayload: () => Promise.resolve(asanaFixtureUpdatePayload),
      },
      webhookVerificationKey: 'synthetic-verification-key',
      webhookTargetUrl: 'https://example.invalid/asana-webhook',
      clock: { now: () => ASANA_FIXTURE_NOW },
    };
    expect(() =>
      createAsanaLiveComposition({
        ...shared,
        currentSnapshot: asanaFixtureSnapshot,
        transport: {
          credentials: {
            withBearerToken: () =>
              Promise.reject(new Error('credential use is not expected')),
          },
        },
      }),
    ).toThrow('ASANA_LIVE_COMPOSITION_REQUIRES_LIVE_SNAPSHOT');

    const liveSnapshot = {
      ...asanaFixtureSnapshot,
      runtimeMode: 'live' as const,
    };
    expect(() =>
      createAsanaLiveComposition({
        ...shared,
        currentSnapshot: liveSnapshot,
        transport: {
          credentials: {
            withBearerToken: () =>
              Promise.reject(new Error('credential use is not expected')),
          },
          fetch: () => {
            injectedFetchCalls += 1;
            return Promise.reject(new Error('must never run'));
          },
        } as never,
      }),
    ).toThrow('ASANA_LIVE_COMPOSITION_TRANSPORT_AUTHORITY_REJECTED');
    expect(injectedFetchCalls).toBe(0);
  });
});
