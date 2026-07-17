import { assertCommunicationConnectorContract } from '@chief/connector-testkit';
import { tenantIdSchema } from '@chief/contracts/ids';
import { describe, expect, it } from 'vitest';

import { GmailConnector, GmailHistoryResetRequiredError } from './connector.js';
import { gmailConnectorDescriptor, GMAIL_OAUTH_SCOPES } from './descriptor.js';
import {
  createGmailContractFixtures,
  createGmailFixtureDependencies,
} from './provider-fixtures.js';

describe('GmailConnector', () => {
  it('passes the frozen provider connector contract suite', async () => {
    const fixtures = createGmailContractFixtures();
    const connector = new GmailConnector(
      createGmailFixtureDependencies(fixtures),
    );
    const report = await assertCommunicationConnectorContract(
      connector,
      fixtures,
    );
    expect(report.passed).toBe(true);
  });

  it('declares the exact minimum OAuth scopes and keeps Pub/Sub disabled', () => {
    const descriptor = gmailConnectorDescriptor();
    expect(descriptor.authorizationScopes).toEqual([...GMAIL_OAUTH_SCOPES]);
    expect(descriptor.authorizationScopes).not.toContain(
      'https://www.googleapis.com/auth/gmail.modify',
    );
    expect(descriptor.capabilities).toMatchObject({
      read: true,
      send: true,
      poll: true,
      historicalBackfill: true,
      webhook: false,
      deliveryFeedback: false,
    });
  });

  it('builds PKCE authorization and rejects scope expansion', async () => {
    const fixtures = createGmailContractFixtures();
    const connector = new GmailConnector(
      createGmailFixtureDependencies(fixtures),
    );
    const request = {
      schemaVersion: '1' as const,
      tenantId: fixtures.account.tenantId,
      userId: fixtures.account.ownerUserId,
      connectorId: 'gmail',
      redirectUri: 'https://chief.example.invalid/oauth/gmail/callback',
      stateDigest: 'd'.repeat(64),
      pkceChallenge: 'p'.repeat(43),
      requestedScopes: [...GMAIL_OAUTH_SCOPES],
    };
    const started = await connector.beginAuthorization(request);
    const url = new URL(started.authorizationUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('client_id')).toBe(
      'gmail-fixture-client-id.apps.example.invalid',
    );
    expect(url.searchParams.get('scope')).toBe(GMAIL_OAUTH_SCOPES.join(' '));
    expect(() =>
      connector.beginAuthorization({
        ...request,
        requestedScopes: [
          ...GMAIL_OAUTH_SCOPES,
          'https://www.googleapis.com/auth/gmail.modify',
        ],
      }),
    ).toThrow('GMAIL_OAUTH_SCOPE_SET_REJECTED');
  });

  it('fails closed when Gmail invalidates an old historyId', async () => {
    const fixtures = createGmailContractFixtures();
    const dependencies = createGmailFixtureDependencies(fixtures);
    dependencies.history.listHistory = () =>
      Promise.reject(new Error('GMAIL_HISTORY_ID_TOO_OLD'));
    const connector = new GmailConnector(dependencies);
    await expect(
      connector.poll(fixtures.accountRef, fixtures.pollRequest),
    ).rejects.toBeInstanceOf(GmailHistoryResetRequiredError);
  });

  it('retains the original history fence across bounded continuation pages', async () => {
    const fixtures = createGmailContractFixtures();
    const dependencies = createGmailFixtureDependencies(fixtures);
    const observed: { startHistoryId: string; pageToken?: string }[] = [];
    dependencies.history.listHistory = (input) => {
      observed.push({
        startHistoryId: input.startHistoryId,
        ...(input.pageToken === undefined
          ? {}
          : { pageToken: input.pageToken }),
      });
      return Promise.resolve({
        history: [],
        historyId: '150',
        ...(input.pageToken === undefined ? { nextPageToken: 'page-2' } : {}),
        providerResponseHash: 'a'.repeat(64),
      });
    };
    const connector = new GmailConnector(dependencies);
    const first = await connector.poll(fixtures.accountRef, {
      ...fixtures.pollRequest,
      maxPages: 1,
    });
    expect(first.complete).toBe(false);
    expect(first.nextEncryptedCursor).toBe(
      'fixture-history:100|latest:150|page:page-2',
    );
    const second = await connector.poll(fixtures.accountRef, {
      ...fixtures.pollRequest,
      checkpoint: {
        ...fixtures.pollRequest.checkpoint,
        encryptedCursor: first.nextEncryptedCursor ?? '',
      },
      maxPages: 1,
    });
    expect(second.complete).toBe(true);
    expect(second.nextEncryptedCursor).toBe('fixture-history:150');
    expect(observed).toEqual([
      { startHistoryId: '100' },
      { startHistoryId: '100', pageToken: 'page-2' },
    ]);
  });

  it('rejects a cross-tenant OAuth account substitution', async () => {
    const fixtures = createGmailContractFixtures();
    const dependencies = createGmailFixtureDependencies(fixtures);
    const connector = new GmailConnector({
      ...dependencies,
      oauth: {
        completeAuthorization: () =>
          Promise.resolve({
            account: {
              ...fixtures.account,
              tenantId: tenantIdSchema.parse('tenant-substituted'),
            },
            authorizationAudience: 'https://gmail.googleapis.com/',
            grantedScopes: [...GMAIL_OAUTH_SCOPES],
          }),
      },
    });
    await expect(
      connector.completeAuthorization({
        schemaVersion: '1',
        tenantId: fixtures.account.tenantId,
        userId: fixtures.account.ownerUserId,
        stateDigest: 'e'.repeat(64),
        code: 'authorization-code-fixture',
        pkceVerifier: 'v'.repeat(43),
        callbackUri: 'https://chief.example.invalid/oauth/gmail/callback',
      }),
    ).rejects.toThrow('GMAIL_OAUTH_ACCOUNT_BINDING_MISMATCH');
  });
});
