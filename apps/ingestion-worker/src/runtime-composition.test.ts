import {
  immutableBlobRefSchema,
  type ConnectorSnapshot,
} from '@chief/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createFixtureIngestionHandler } from './handler.js';
import {
  createProductionSqsHandler,
  parseProductionIngestionRequest,
  type SqsEvent,
} from './production-ingress.js';
import {
  loadProductionIngestionConfig,
  parseConnectorBindings,
} from './runtime-config.js';
import type {
  GmailRecord,
  IngestionEvent,
  IngestionWorkItem,
} from './types.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const BINDINGS =
  'gmail=gmail@1.0.0,microsoft_graph=microsoft-graph@1.0.0-wave1a,imap=imap-smtp@1.0.0-protocol,twilio_sms=twilio-sms@1.0.0,twilio_whatsapp=twilio-whatsapp@1.0.0,x=x_legacy_dm@1.0.0,linkedin_archive=linkedin-communications@1.0.0-scaffold,asana=asana-work-management@1.0.0';

function environment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    INGESTION_RUNTIME_MODE: 'production',
    CORE_TABLE_NAME: 'core',
    CONNECTOR_RUNTIME_TABLE_NAME: 'connector-runtime',
    RETRIEVAL_TABLE_NAME: 'retrieval',
    SNAPSHOT_BUCKET_NAME: 'snapshot-bucket',
    DIGEST_KEY_SECRET_ARN: 'arn:aws:secretsmanager:region:account:secret:key',
    PRODUCT_DATA_KEY_ARN: 'arn:aws:kms:region:account:key/key-id',
    INGESTION_THREAD_LOOKUP_INDEX_NAME: 'ThreadLookupIndex',
    INGESTION_IDENTITY_LOOKUP_INDEX_NAME: 'IdentityLookupIndex',
    INGESTION_ASANA_TOPIC_LOOKUP_INDEX_NAME: 'AsanaTopicLookupIndex',
    INGESTION_CONNECTOR_BINDINGS: BINDINGS,
    ...overrides,
  };
}

function gmailWorkItem(
  overrides: Partial<IngestionWorkItem> = {},
): IngestionWorkItem {
  const record: GmailRecord = {
    kind: 'gmail',
    id: 'provider-message-1',
    threadId: 'provider-thread-1',
    internalDate: String(Date.parse('2026-07-17T12:00:00.000Z')),
    labels: ['INBOX'],
    direction: 'inbound',
    headers: {
      From: 'sender@example.test',
      To: 'executive@example.test',
      Subject: 'Fixture subject',
    },
    textBody: 'Fixture body',
    attachments: [],
  };
  const snapshot: ConnectorSnapshot = {
    connectorId: 'gmail',
    descriptorVersion: '1.0.0',
    accountId: 'gmail-account' as ConnectorSnapshot['accountId'],
    capabilitySnapshotHash: HASH_B,
    runtimeMode: 'live',
    selectionState: 'selected',
  };
  return {
    schemaVersion: '1',
    workItemId: 'work-1',
    source: 'gmail',
    tenantId: 'tenant-a',
    accountId: 'gmail-account',
    connectorSnapshot: snapshot,
    rawReference: immutableBlobRefSchema.parse({
      schemaVersion: '1',
      tenantId: 'tenant-a',
      bucketRef: 'fixture-raw',
      objectKey: 'raw/provider-message-1',
      objectVersion: HASH_A,
      contentHash: HASH_A,
      byteLength: 100,
      mediaType: 'application/json',
      encryptionKeyRef: 'fixture-kms',
      retentionPolicyVersion: '1',
    }),
    record,
    authorizationEpoch: 3,
    scopeHash: HASH_A,
    brandIds: ['brand-a'],
    ...overrides,
  };
}

function ingestionEvent(item = gmailWorkItem()): IngestionEvent {
  return {
    schemaVersion: '1',
    invocationId: 'invocation-1',
    receivedAt: '2026-07-17T12:01:00.000Z',
    workItems: [item],
  };
}

function eventBridgeBody(item = gmailWorkItem()): string {
  return JSON.stringify({
    source: 'chief.connectors',
    'detail-type': 'communication.ingest.requested',
    detail: {
      schemaVersion: '1',
      authority: {
        derivation: 'server_grants',
        tenantId: 'tenant-a',
        accountIds: ['gmail-account'],
        brandIds: ['brand-a'],
        authorizationEpoch: 3,
        scopeHash: HASH_A,
      },
      ingestionEvent: ingestionEvent(item),
    },
  });
}

describe('production ingestion configuration', () => {
  it('loads only the complete explicit production configuration', () => {
    const config = loadProductionIngestionConfig(environment());

    expect(config.runtimeMode).toBe('production');
    expect(config.connectorBindings.get('gmail')).toEqual({
      source: 'gmail',
      connectorId: 'gmail',
      descriptorVersion: '1.0.0',
    });
    expect([...config.connectorBindings.keys()]).not.toContain('demo');
  });

  it.each([
    ['missing table', { CORE_TABLE_NAME: undefined }],
    ['fixture deployment', { INGESTION_RUNTIME_MODE: 'fixture' }],
    [
      'missing connector binding',
      { INGESTION_CONNECTOR_BINDINGS: 'gmail=gmail@1.0.0' },
    ],
    [
      'invalid connector binding',
      { INGESTION_CONNECTOR_BINDINGS: `${BINDINGS},demo=demo@1.0.0` },
    ],
  ])('fails closed for %s', (_name, overrides) => {
    expect(() =>
      loadProductionIngestionConfig(environment(overrides)),
    ).toThrow();
  });
});

describe('production ingestion authority and connector admission', () => {
  const bindings = parseConnectorBindings(BINDINGS);

  it('accepts a fully server-bound connector event without provider calls', () => {
    const request = parseProductionIngestionRequest(
      eventBridgeBody(),
      bindings,
    );

    expect(request.authority.derivation).toBe('server_grants');
    expect(request.ingestionEvent.workItems).toHaveLength(1);
  });

  it.each([
    ['tenant substitution', gmailWorkItem({ tenantId: 'tenant-b' })],
    ['account substitution', gmailWorkItem({ accountId: 'other-account' })],
    ['scope substitution', gmailWorkItem({ scopeHash: 'c'.repeat(64) })],
    [
      'authorization epoch substitution',
      gmailWorkItem({ authorizationEpoch: 4 }),
    ],
    [
      'connector substitution',
      gmailWorkItem({
        connectorSnapshot: {
          ...gmailWorkItem().connectorSnapshot,
          connectorId: 'unregistered-gmail',
        },
      }),
    ],
    [
      'fixture authority in production',
      gmailWorkItem({
        connectorSnapshot: {
          ...gmailWorkItem().connectorSnapshot,
          runtimeMode: 'fixture',
        },
      }),
    ],
  ])('rejects %s', (_name, item) => {
    expect(() =>
      parseProductionIngestionRequest(eventBridgeBody(item), bindings),
    ).toThrow();
  });

  it('returns only failed SQS item identifiers for deterministic redrive', async () => {
    const processEvent = vi.fn(() => Promise.resolve());
    const handler = createProductionSqsHandler(processEvent, bindings);
    const event: SqsEvent = {
      Records: [
        { messageId: 'good', body: eventBridgeBody() },
        {
          messageId: 'bad',
          body: eventBridgeBody(gmailWorkItem({ scopeHash: HASH_B })),
        },
      ],
    };

    await expect(handler(event)).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'bad' }],
    });
    expect(processEvent).toHaveBeenCalledOnce();
  });
});

describe('explicit fixture composition', () => {
  it('is deterministic, credentialless, and never selected by production', async () => {
    const fixtureItem = gmailWorkItem({
      connectorSnapshot: {
        ...gmailWorkItem().connectorSnapshot,
        connectorId: 'connector-gmail',
        descriptorVersion: '1',
        runtimeMode: 'fixture',
      },
    });
    const first = await createFixtureIngestionHandler()(
      ingestionEvent(fixtureItem),
    );
    const second = await createFixtureIngestionHandler()(
      ingestionEvent(fixtureItem),
    );

    expect({ ...first, durationMs: 0 }).toEqual({ ...second, durationMs: 0 });
    expect(first).toMatchObject({
      status: 'complete',
      processed: 1,
      quarantined: 0,
      externalProviderCalls: 0,
    });
  });
});
