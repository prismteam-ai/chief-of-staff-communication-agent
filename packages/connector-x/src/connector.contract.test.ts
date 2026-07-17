import { assertCommunicationConnectorContract } from '@chief/connector-testkit';
import { accountIdSchema, tenantIdSchema } from '@chief/contracts/ids';
import { describe, expect, it } from 'vitest';

import {
  createXChatEncryptedBlockedConnector,
  createXLegacyDmFixtureConnector,
  xChatEncryptedBlockedConnector,
  xChatEncryptedFixtures,
  xLegacyDmFixtureConnector,
  xLegacyDmFixtures,
} from './connector.js';
import { createXRunnerControlFixtures } from './contract-fixtures.js';
import {
  xChatEncryptedDescriptor,
  xLegacyDmDescriptor,
} from './implementation-metadata.js';

describe('X connector contracts', () => {
  it('passes the shared runner with an isolated legacy control fixture', async () => {
    const contractFixtures = createXRunnerControlFixtures(xLegacyDmDescriptor);
    expect(contractFixtures.snapshot).toMatchObject({
      runtimeMode: 'live',
      selectionState: 'selected',
    });
    expect(xLegacyDmFixtures.snapshot.runtimeMode).toBe('fixture');
    const report = await assertCommunicationConnectorContract(
      createXLegacyDmFixtureConnector(contractFixtures),
      contractFixtures,
    );
    expect(report.passed).toBe(true);
    expect(report.checks.every(({ passed }) => passed)).toBe(true);
  });

  it('passes the shared runner with an isolated XChat control fixture', async () => {
    const contractFixtures = createXRunnerControlFixtures(
      xChatEncryptedDescriptor,
    );
    expect(contractFixtures.snapshot).toMatchObject({
      runtimeMode: 'live',
      selectionState: 'selected',
    });
    expect(xChatEncryptedFixtures.snapshot.runtimeMode).toBe(
      'blocked_external_access',
    );
    const report = await assertCommunicationConnectorContract(
      createXChatEncryptedBlockedConnector(contractFixtures),
      contractFixtures,
    );
    expect(report.passed).toBe(true);
  });

  it('keeps provider/default snapshots truthful and non-live', () => {
    expect(xLegacyDmFixtures.snapshot).toMatchObject({
      runtimeMode: 'fixture',
      selectionState: 'selected',
    });
    expect(xChatEncryptedFixtures.snapshot).toMatchObject({
      runtimeMode: 'blocked_external_access',
      selectionState: 'not_applicable',
    });
    expect(xLegacyDmFixtureConnector.descriptor().capabilities).toMatchObject({
      send: false,
      externalEffect: false,
    });
    expect(
      xChatEncryptedBlockedConnector.descriptor().capabilities,
    ).toMatchObject({ send: false, externalEffect: false });
  });

  it('keeps live OAuth exchange, send, entitlement checks, and spend unreachable', async () => {
    expect(xLegacyDmFixtureConnector.send).toBeUndefined();
    expect(xLegacyDmFixtureConnector.reconcileSend).toBeUndefined();
    expect(xLegacyDmFixtureConnector.verifyWebhook).toBeUndefined();
    expect(xChatEncryptedBlockedConnector.fetchMessage).toBeUndefined();
    expect(xChatEncryptedBlockedConnector.poll).toBeUndefined();
    expect(xChatEncryptedBlockedConnector.send).toBeUndefined();
    await expect(
      xLegacyDmFixtureConnector.completeAuthorization({
        schemaVersion: '1',
        tenantId: xLegacyDmFixtures.account.tenantId,
        userId: xLegacyDmFixtures.account.ownerUserId,
        stateDigest: 'a'.repeat(64),
        code: 'never-exchanged',
        pkceVerifier: 'v'.repeat(43),
        callbackUri: 'https://example.invalid/callback',
      }),
    ).rejects.toThrow('X_OAUTH_TOKEN_EXCHANGE_DISABLED');
  });

  it('binds PKCE and exact legacy scopes without XChat scope reuse', async () => {
    const start = await xLegacyDmFixtureConnector.beginAuthorization({
      schemaVersion: '1',
      tenantId: xLegacyDmFixtures.account.tenantId,
      userId: xLegacyDmFixtures.account.ownerUserId,
      connectorId: 'x_legacy_dm',
      redirectUri: 'https://example.invalid/callback',
      stateDigest: 'a'.repeat(64),
      pkceChallenge: 'c'.repeat(43),
      requestedScopes: [
        'tweet.read',
        'users.read',
        'dm.read',
        'dm.write',
        'offline.access',
      ],
    });
    const url = new URL(start.authorizationUrl);
    expect(url.origin).toBe('https://x.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'tweet.read',
      'users.read',
      'dm.read',
      'dm.write',
      'offline.access',
    ]);
    expect(xChatEncryptedBlockedConnector.authorizationStrategy()).toEqual({
      strategy: 'external',
    });
  });

  it('denies cross-tenant and cross-account fixture reads', async () => {
    const fetchMessage = xLegacyDmFixtureConnector.fetchMessage;
    const poll = xLegacyDmFixtureConnector.poll;
    if (fetchMessage === undefined || poll === undefined) {
      throw new Error('legacy fixture methods missing');
    }
    await expect(
      fetchMessage(
        {
          ...xLegacyDmFixtures.account,
          tenantId: tenantIdSchema.parse('tenant-other'),
        },
        { providerMessageId: '1900000000000000001' },
      ),
    ).rejects.toThrow('X_ACCOUNT_SCOPE_MISMATCH');
    await expect(
      poll(
        {
          ...xLegacyDmFixtures.accountRef,
          accountId: accountIdSchema.parse('account-other'),
        },
        xLegacyDmFixtures.pollRequest,
      ),
    ).rejects.toThrow('X_ACCOUNT_SCOPE_MISMATCH');
  });
});
