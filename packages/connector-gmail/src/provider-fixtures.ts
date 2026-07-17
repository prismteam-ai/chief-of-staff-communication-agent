import {
  effectExecutionArtifactSchema,
  reconcileSendRequestSchema,
} from '@chief/contracts/approval';
import {
  connectorAccountSchema,
  connectorDescriptorSchema,
  connectorSnapshotSchema,
  pollRequestSchema,
  verifiedProviderEventSchema,
} from '@chief/contracts/connectors';
import {
  createConnectorContractFixtures,
  FIXTURE_HASH,
  FIXTURE_HASH_B,
  FIXTURE_NOW,
} from '@chief/connector-testkit';
import type { ConnectorContractFixtures } from '@chief/connector-testkit';

import {
  gmailConnectorDescriptor,
  GMAIL_DESCRIPTOR_VERSION,
} from './descriptor.js';
import { GMAIL_RECONCILIATION_STRATEGY } from './send.js';
import type {
  GmailConnectorDependencies,
  GmailProviderMessage,
} from './types.js';

const textBody = Buffer.from(
  'Hello from the provider-shaped Gmail fixture.',
).toString('base64url');
const htmlBody = Buffer.from(
  '<p>Hello from the provider-shaped Gmail fixture.</p>',
).toString('base64url');

export const GMAIL_PROVIDER_MESSAGE_FIXTURE: GmailProviderMessage = {
  id: 'provider-message-a',
  threadId: 'provider-thread-a',
  historyId: '101',
  internalDate: String(Date.parse(FIXTURE_NOW)),
  labelIds: ['INBOX', 'IMPORTANT'],
  rawBodyRef: 's3://private-fixture/gmail/provider-message-a',
  canonicalPayloadHash: FIXTURE_HASH_B,
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Alex Example <alex@example.invalid>' },
      { name: 'To', value: 'Chief <chief@example.invalid>' },
      { name: 'Cc', value: 'Ops <ops@example.invalid>' },
      { name: 'Subject', value: 'Quarterly plan' },
      { name: 'Message-ID', value: '<provider-message-a@example.invalid>' },
      {
        name: 'In-Reply-To',
        value: '<provider-message-prior@example.invalid>',
      },
      {
        name: 'References',
        value:
          '<provider-message-root@example.invalid> <provider-message-prior@example.invalid>',
      },
    ],
    parts: [
      {
        partId: '0',
        mimeType: 'multipart/alternative',
        parts: [
          { partId: '0.0', mimeType: 'text/plain', body: { data: textBody } },
          { partId: '0.1', mimeType: 'text/html', body: { data: htmlBody } },
        ],
      },
      {
        partId: '1',
        mimeType: 'application/pdf',
        filename: 'plan.pdf',
        body: { attachmentId: 'attachment-a', size: 321 },
      },
    ],
  },
};

export function createGmailContractFixtures(): ConnectorContractFixtures {
  const base = createConnectorContractFixtures();
  const descriptor = gmailConnectorDescriptor();
  const controlDescriptor = connectorDescriptorSchema.parse({
    ...base.descriptor,
    connectorId: descriptor.connectorId,
    descriptorVersion: descriptor.descriptorVersion,
    provider: descriptor.provider,
    channel: descriptor.channel,
  });
  const snapshot = connectorSnapshotSchema.parse({
    ...base.snapshot,
    connectorId: descriptor.connectorId,
    descriptorVersion: descriptor.descriptorVersion,
  });
  const account = connectorAccountSchema.parse({
    ...base.account,
    provider: descriptor.provider,
    channel: descriptor.channel,
    displayLabel: 'Gmail fixture account',
    snapshot,
  });
  const accountRef = {
    tenantId: account.tenantId,
    accountId: account.accountId,
    expectedStateVersion: account.stateVersion,
  };
  const artifact = effectExecutionArtifactSchema.parse({
    ...base.artifact,
    account: accountRef,
    connectorSnapshot: snapshot,
    clientCorrelation: {
      kind: 'rfc_message_id',
      value: '<operation-a@chief.invalid>',
    },
    correlationBindingVersion: '1',
    reconciliationStrategy: GMAIL_RECONCILIATION_STRATEGY,
    reconciliationStrategyVersion: '1',
  });
  const reconcileRequest = reconcileSendRequestSchema.parse({
    ...base.reconcileRequest,
    artifact,
    priorAttemptId: artifact.attemptId,
    strategy: artifact.reconciliationStrategy,
    strategyVersion: artifact.reconciliationStrategyVersion,
  });
  const verifiedEvent = verifiedProviderEventSchema.parse({
    ...base.verifiedEvent,
    accountId: account.accountId,
    connectorSnapshot: snapshot,
  });
  const pollRequest = pollRequestSchema.parse({
    ...base.pollRequest,
    account: accountRef,
    checkpoint: {
      ...base.pollRequest.checkpoint,
      tenantId: account.tenantId,
      accountId: account.accountId,
      kind: 'history',
      encryptedCursor: 'fixture-history:100',
      adapterVersion: GMAIL_DESCRIPTOR_VERSION,
    },
    adapterVersion: GMAIL_DESCRIPTOR_VERSION,
  });

  return {
    ...base,
    // The frozen testkit uses this descriptor only for its independent,
    // deliberately effectful/fenced control adapter. The adapter under test
    // always supplies its own truthful Gmail descriptor.
    descriptor: controlDescriptor,
    snapshot,
    account,
    accountRef,
    artifact,
    reconcileRequest,
    verifiedEvent,
    pollRequest,
    feedbackContext: {
      ...base.feedbackContext,
      account: accountRef,
      connectorSnapshot: snapshot,
    },
  };
}

export function createGmailFixtureDependencies(
  fixtures = createGmailContractFixtures(),
): GmailConnectorDependencies & {
  readonly calls: { send: number; history: number; reconcile: number };
} {
  const calls = { send: 0, history: 0, reconcile: 0 };
  return {
    calls,
    now: () => FIXTURE_NOW,
    oauthClientId: 'gmail-fixture-client-id.apps.example.invalid',
    oauth: {
      completeAuthorization: () =>
        Promise.resolve({
          account: fixtures.account,
          authorizationAudience: 'https://gmail.googleapis.com/',
          grantedScopes: [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.send',
          ],
        }),
    },
    cursorCodec: {
      decodeHistoryCursor: (request) => {
        const prefix = 'fixture-history:';
        if (!request.checkpoint.encryptedCursor.startsWith(prefix)) {
          throw new Error('FIXTURE_HISTORY_CURSOR_INVALID');
        }
        const value = request.checkpoint.encryptedCursor.slice(prefix.length);
        const [historyAndLatest, pageToken] = value.split('|page:', 2);
        const [historyId, latestHistoryId] = (historyAndLatest ?? '').split(
          '|latest:',
          2,
        );
        if (historyId === undefined || historyId.length === 0) {
          throw new Error('FIXTURE_HISTORY_CURSOR_INVALID');
        }
        return {
          historyId,
          ...(pageToken === undefined ? {} : { pageToken }),
          ...(latestHistoryId === undefined ? {} : { latestHistoryId }),
        };
      },
      encodeHistoryCursor: (cursor) =>
        `fixture-history:${cursor.historyId}${
          cursor.latestHistoryId === undefined
            ? ''
            : `|latest:${cursor.latestHistoryId}`
        }${cursor.pageToken === undefined ? '' : `|page:${cursor.pageToken}`}`,
    },
    history: {
      snapshotForAccount: () => fixtures.snapshot,
      getCurrentHistoryId: () =>
        Promise.resolve({
          historyId: '100',
          providerResponseHash: FIXTURE_HASH,
        }),
      listMessagesForBackfill: () =>
        Promise.resolve({
          messages: [
            {
              id: GMAIL_PROVIDER_MESSAGE_FIXTURE.id,
              threadId: GMAIL_PROVIDER_MESSAGE_FIXTURE.threadId,
            },
          ],
          providerResponseHash: FIXTURE_HASH,
        }),
      validateConnection: (account) =>
        Promise.resolve({
          account,
          health: 'healthy',
          observedAt: FIXTURE_NOW,
          capabilitySnapshotHash: fixtures.snapshot.capabilitySnapshotHash,
        }),
      listHistory: () => {
        calls.history += 1;
        return Promise.resolve({
          history: [
            {
              id: '101',
              messagesAdded: [
                {
                  message: {
                    id: GMAIL_PROVIDER_MESSAGE_FIXTURE.id,
                    threadId: GMAIL_PROVIDER_MESSAGE_FIXTURE.threadId,
                  },
                },
              ],
            },
          ],
          historyId: '101',
          providerResponseHash: FIXTURE_HASH,
        });
      },
      getMessage: (_account, providerMessageId) => {
        if (providerMessageId !== GMAIL_PROVIDER_MESSAGE_FIXTURE.id) {
          throw new Error('GMAIL_FIXTURE_MESSAGE_NOT_FOUND');
        }
        return Promise.resolve(GMAIL_PROVIDER_MESSAGE_FIXTURE);
      },
      getThread: (_account, providerThreadId) => {
        if (providerThreadId !== GMAIL_PROVIDER_MESSAGE_FIXTURE.threadId) {
          throw new Error('GMAIL_FIXTURE_THREAD_NOT_FOUND');
        }
        return Promise.resolve({
          id: providerThreadId,
          historyId: GMAIL_PROVIDER_MESSAGE_FIXTURE.historyId,
          messages: [GMAIL_PROVIDER_MESSAGE_FIXTURE],
        });
      },
    },
    send: {
      sendPrepared: () => {
        calls.send += 1;
        return Promise.resolve({
          outcome: 'accepted',
          providerMessageId: 'gmail-sent-message-a',
          providerThreadId: 'provider-thread-a',
          providerResponseHash: FIXTURE_HASH,
          observedAt: FIXTURE_NOW,
        });
      },
      findSentByClientCorrelation: () => {
        calls.reconcile += 1;
        return Promise.resolve([
          {
            outcome: 'accepted',
            providerMessageId: 'gmail-sent-message-a',
            providerThreadId: 'provider-thread-a',
            providerResponseHash: FIXTURE_HASH,
            observedAt: FIXTURE_NOW,
          },
        ]);
      },
    },
  };
}
