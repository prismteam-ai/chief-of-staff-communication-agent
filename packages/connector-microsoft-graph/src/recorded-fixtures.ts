import type {
  GraphDeltaResponse,
  GraphMessage,
  GraphNotificationCollection,
} from './graph-types.js';

export const GRAPH_FIXTURE_NOW = '2026-07-17T12:00:00.000Z';
export const GRAPH_FIXTURE_LATER = '2026-07-17T13:00:00.000Z';
export const GRAPH_FIXTURE_CLIENT_STATE = 'fixture-client-state-v1';

export const graphMessageFixture = Object.freeze<GraphMessage>({
  '@odata.etag': 'W/"CQAAABYAAADfixture"',
  id: 'provider-message-a',
  conversationId: 'provider-thread-a',
  conversationIndex: 'AdQAAABfixture=',
  internetMessageId: '<graph-fixture-a@example.invalid>',
  subject: 'Quarterly planning',
  bodyPreview: 'Please review the attached plan.',
  body: {
    contentType: 'html',
    content: '<p>Please review the attached plan.</p>',
  },
  from: {
    emailAddress: { name: 'Ada Example', address: 'ada@example.invalid' },
  },
  sender: {
    emailAddress: { name: 'Ada Example', address: 'ada@example.invalid' },
  },
  toRecipients: [
    {
      emailAddress: { name: 'Chief Fixture', address: 'chief@example.invalid' },
    },
  ],
  ccRecipients: [],
  bccRecipients: [],
  replyTo: [
    { emailAddress: { name: 'Ada Example', address: 'ada@example.invalid' } },
  ],
  receivedDateTime: GRAPH_FIXTURE_NOW,
  sentDateTime: GRAPH_FIXTURE_NOW,
  lastModifiedDateTime: GRAPH_FIXTURE_NOW,
  parentFolderId: 'inbox-folder-immutable-a',
  isDraft: false,
  isRead: false,
  hasAttachments: true,
  attachments: [
    {
      '@odata.type': '#microsoft.graph.fileAttachment',
      id: 'attachment-immutable-a',
      name: 'plan.txt',
      contentType: 'text/plain',
      size: 12,
      isInline: false,
      contentBytes: 'cGxhbiBmaXh0dXJl',
    },
  ],
  internetMessageHeaders: [
    { name: 'In-Reply-To', value: '<previous@example.invalid>' },
    {
      name: 'References',
      value: '<root@example.invalid> <previous@example.invalid>',
    },
  ],
});

export const graphDeltaFixture: GraphDeltaResponse = Object.freeze({
  '@odata.context':
    "https://graph.microsoft.com/v1.0/$metadata#users('fixture')/mailFolders('inbox')/messages",
  value: [graphMessageFixture],
  '@odata.deltaLink':
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=fixture-terminal',
});

export const graphNotificationFixture =
  Object.freeze<GraphNotificationCollection>({
    value: [
      {
        subscriptionId: 'subscription-fixture-a',
        subscriptionExpirationDateTime: '2026-07-18T12:00:00.000Z',
        changeType: 'created',
        resource: 'users/fixture/messages/provider-message-a',
        clientState: GRAPH_FIXTURE_CLIENT_STATE,
        tenantId: 'personal-microsoft-account',
        resourceData: {
          '@odata.type': '#Microsoft.Graph.Message',
          '@odata.id': 'users/fixture/messages/provider-message-a',
          '@odata.etag': 'W/"CQAAABYAAADfixture"',
          id: 'provider-message-a',
        },
      },
    ],
  });

export const graphLifecycleFixture = Object.freeze<GraphNotificationCollection>(
  {
    value: [
      {
        subscriptionId: 'subscription-fixture-a',
        subscriptionExpirationDateTime: '2026-07-18T12:00:00.000Z',
        lifecycleEvent: 'reauthorizationRequired',
        resource: 'users/fixture/mailFolders/inbox/messages',
        clientState: GRAPH_FIXTURE_CLIENT_STATE,
      },
      {
        subscriptionId: 'subscription-fixture-b',
        subscriptionExpirationDateTime: '2026-07-18T12:00:00.000Z',
        lifecycleEvent: 'subscriptionRemoved',
        resource: 'users/fixture/mailFolders/inbox/messages',
        clientState: GRAPH_FIXTURE_CLIENT_STATE,
      },
      {
        subscriptionId: 'subscription-fixture-c',
        subscriptionExpirationDateTime: '2026-07-18T12:00:00.000Z',
        lifecycleEvent: 'missed',
        resource: 'users/fixture/mailFolders/inbox/messages',
        clientState: GRAPH_FIXTURE_CLIENT_STATE,
      },
    ],
  },
);

export function graphNotificationBodyBase64(
  payload: GraphNotificationCollection = graphNotificationFixture,
): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
