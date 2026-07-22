import { createHash } from 'node:crypto';

import {
  connectorSnapshotSchema,
  deterministicEvaluatorIdentityV1,
  deterministicEvaluatorIdentityV2,
  immutableBlobRefSchema,
  type ConnectorSnapshot,
} from '@chief/contracts';
import { resetDemoCorpus, type DemoChannel } from '@chief/demo-fixtures';
import { canonicalJson } from '@chief/rag';

import type {
  DemoRecord,
  GmailRecord,
  GraphRecord,
  IngestionSource,
  IngestionWorkItem,
  LinkedinArchiveRecord,
  ProviderRecord,
  TwilioRecord,
  XRecord,
} from '../types.js';

export const HOSTED_CORPUS_SEED_AT = '2026-07-17T12:00:00.000Z';

export const hostedEvaluatorChannelCountsV2 = Object.freeze({
  gmail: 161,
  microsoft_graph: 161,
  sms: 161,
  whatsapp: 161,
  x: 161,
  linkedin_archive: 161,
  future_demo: 154,
});

export const hostedEvaluatorBrandCountsV2 = Object.freeze({
  'brand-northstar': 637,
  'brand-harbor': 483,
});

const anchorByCorpusRevision = new Map<
  string,
  (typeof deterministicEvaluatorIdentityV2.anchorOverlays)[number]
>(
  deterministicEvaluatorIdentityV2.anchorOverlays.map((anchor) => [
    anchor.corpusMessageRevisionId,
    anchor,
  ]),
);

const anchorThreadByCorpusThread = new Map<string, string>(
  deterministicEvaluatorIdentityV2.anchorOverlays.map((anchor) => [
    anchor.corpusThreadId,
    anchor.providerThreadId,
  ]),
);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hostedAccountId(accountId: string): string {
  return accountId === 'account-tenant-demo-northstar-gmail-00'
    ? deterministicEvaluatorIdentityV2.accountId
    : accountId;
}

function hostedThreadId(threadId: string): string {
  return anchorThreadByCorpusThread.get(threadId) ?? threadId;
}

function sourceFor(channel: DemoChannel): IngestionSource {
  if (channel === 'sms') return 'twilio_sms';
  if (channel === 'whatsapp') return 'twilio_whatsapp';
  if (channel === 'future_demo') return 'demo';
  return channel;
}

function connectorSnapshot(input: {
  readonly channel: DemoChannel;
  readonly accountId: string;
  readonly snapshot: ConnectorSnapshot;
}): ConnectorSnapshot {
  if (input.channel === 'gmail') {
    return connectorSnapshotSchema.parse({
      connectorId: deterministicEvaluatorIdentityV1.connector.connectorId,
      descriptorVersion:
        deterministicEvaluatorIdentityV1.connector.descriptorVersion,
      accountId: deterministicEvaluatorIdentityV2.accountId,
      capabilitySnapshotHash:
        deterministicEvaluatorIdentityV1.connector.capabilitySnapshotHash,
      runtimeMode: deterministicEvaluatorIdentityV1.connector.runtimeMode,
      selectionState: 'selected',
    });
  }
  return connectorSnapshotSchema.parse({
    ...input.snapshot,
    accountId: input.accountId,
  });
}

function anchorRecord(
  anchor: (typeof deterministicEvaluatorIdentityV2.anchorOverlays)[number],
): GmailRecord {
  const launch = anchor === deterministicEvaluatorIdentityV2.anchorOverlays[0];
  return {
    kind: 'gmail',
    id: anchor.providerMessageId,
    threadId: anchor.providerThreadId,
    internalDate: String(
      Date.parse(
        launch ? '2026-07-17T10:52:00.000Z' : '2026-07-17T11:06:00.000Z',
      ),
    ),
    labels: ['INBOX'],
    direction: 'inbound',
    headers: {
      From: launch
        ? 'synthetic-jordan@example.invalid'
        : 'synthetic-priya@example.invalid',
      To: 'public-evaluator@example.invalid',
      Subject: launch ? 'Friday launch decision' : 'Board update numbers',
    },
    textBody: launch
      ? 'Can we confirm the Friday launch and the owner for QA? The Friday launch decision is pending confirmation of the QA owner.'
      : 'Please send the approved pipeline numbers for the board note.',
    attachments: [],
  };
}

function providerRecord(input: {
  readonly channel: DemoChannel;
  readonly messageId: string;
  readonly threadId: string;
  readonly sourceTimestamp: string;
  readonly direction: 'inbound' | 'outbound';
  readonly subject?: string;
  readonly body: string;
  readonly deleted: boolean;
}): ProviderRecord {
  const sender = `synthetic-sender-${sha256(input.messageId).slice(0, 12)}`;
  const recipient = 'synthetic-public-evaluator';
  switch (input.channel) {
    case 'gmail':
      return {
        kind: 'gmail',
        id: input.messageId,
        threadId: input.threadId,
        internalDate: String(Date.parse(input.sourceTimestamp)),
        labels: ['INBOX'],
        direction: input.direction,
        headers: {
          From: `${sender}@example.invalid`,
          To: `${recipient}@example.invalid`,
          ...(input.subject === undefined ? {} : { Subject: input.subject }),
        },
        textBody: input.body,
        attachments: [],
        ...(input.deleted ? { deleted: true } : {}),
      } satisfies GmailRecord;
    case 'microsoft_graph':
      return {
        kind: 'microsoft_graph',
        id: input.messageId,
        conversationId: input.threadId,
        receivedDateTime: input.sourceTimestamp,
        direction: input.direction,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        body: { contentType: 'text', content: input.body },
        from: `${sender}@example.invalid`,
        toRecipients: [`${recipient}@example.invalid`],
        attachments: [],
        ...(input.deleted ? { removed: true } : {}),
      } satisfies GraphRecord;
    case 'sms':
    case 'whatsapp':
      return {
        kind: input.channel === 'sms' ? 'twilio_sms' : 'twilio_whatsapp',
        sid: input.messageId,
        conversationId: input.threadId,
        dateCreated: input.sourceTimestamp,
        from: '+15550000001',
        to: '+15550000002',
        body: input.body,
        direction: input.direction,
        media: [],
        ...(input.deleted ? { revoked: true } : {}),
      } satisfies TwilioRecord;
    case 'x':
      return {
        kind: 'x',
        eventId: input.messageId,
        conversationId: input.threadId,
        createdAt: input.sourceTimestamp,
        senderId: sender,
        recipientId: recipient,
        text: input.body,
        direction: input.direction,
        ...(input.deleted ? { deleted: true } : {}),
      } satisfies XRecord;
    case 'linkedin_archive':
      return {
        kind: 'linkedin_archive',
        messageId: input.messageId,
        conversationId: input.threadId,
        sourceTimestamp: input.sourceTimestamp,
        senderParticipantId: sender,
        recipientParticipantIds: [recipient],
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        content: input.body,
        direction: input.direction,
        attachments: [],
        sourceRowSha256: sha256(
          canonicalJson({
            messageId: input.messageId,
            threadId: input.threadId,
            sourceTimestamp: input.sourceTimestamp,
            body: input.body,
          }),
        ),
      } satisfies LinkedinArchiveRecord;
    case 'future_demo':
      return {
        kind: 'demo',
        id: input.messageId,
        threadId: input.threadId,
        channel: input.channel,
        sourceTimestamp: input.sourceTimestamp,
        direction: input.direction,
        sender,
        recipients: [recipient],
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        body: input.body,
        attachments: [],
        ...(input.deleted ? { deleted: true } : {}),
      } satisfies DemoRecord;
  }
}

export interface HostedEvaluatorCorpusV2 {
  readonly workItems: readonly IngestionWorkItem[];
  readonly messageCount: 1_120;
  readonly threadCount: 160;
  readonly accountCount: 7;
  readonly brandCount: 2;
  readonly channelCounts: typeof hostedEvaluatorChannelCountsV2;
  readonly brandCounts: typeof hostedEvaluatorBrandCountsV2;
}

export function buildHostedEvaluatorCorpusV2(): HostedEvaluatorCorpusV2 {
  const corpus = resetDemoCorpus();
  if (
    corpus.manifest.corpusHash !==
      deterministicEvaluatorIdentityV2.corpus.corpusHash ||
    corpus.manifest.seed !== deterministicEvaluatorIdentityV2.corpus.seed ||
    corpus.manifest.generatedAt !==
      deterministicEvaluatorIdentityV2.corpus.generatedAt ||
    corpus.manifest.resetVersion !==
      deterministicEvaluatorIdentityV2.corpus.resetVersion ||
    corpus.manifest.syntheticOnly !== true
  )
    throw new Error('HOSTED_CORPUS_MANIFEST_DRIFT');

  const primaryTenant = deterministicEvaluatorIdentityV2.corpus.primaryTenantId;
  const messages = new Map(
    corpus.messages
      .filter(({ tenantId }) => tenantId === primaryTenant)
      .map((message) => [message.currentRevisionId, message]),
  );
  const bodies = new Map(
    corpus.bodies
      .filter(
        ({ tenantId, classification }) =>
          tenantId === primaryTenant && classification === 'communication',
      )
      .map((body) => [body.sourceRef, body.bodyText]),
  );
  const accounts = new Map(
    corpus.accounts
      .filter(
        ({ tenantId, channel }) =>
          tenantId === primaryTenant && channel !== 'asana',
      )
      .map((account) => [account.accountId, account]),
  );
  const channelCounts = new Map<string, number>();
  const brandCounts = new Map<string, number>();
  const threads = new Set<string>();
  let anchorCount = 0;
  const workItems = corpus.messageRevisions
    .filter(({ tenantId }) => tenantId === primaryTenant)
    .map((revision, index): IngestionWorkItem => {
      const message = messages.get(revision.revisionId);
      const account = accounts.get(revision.connectorSnapshot.accountId);
      const body = bodies.get(revision.fullNormalizedBody.objectKey);
      if (
        message === undefined ||
        account === undefined ||
        account.brandId === undefined ||
        body === undefined
      )
        throw new Error('HOSTED_CORPUS_PARTIAL');
      const brandId = account.brandId;
      const channel = account.channel as DemoChannel;
      const accountId = hostedAccountId(account.accountId);
      const providerThreadId = hostedThreadId(revision.threadId);
      const anchor = anchorByCorpusRevision.get(revision.revisionId);
      const record =
        anchor === undefined
          ? providerRecord({
              channel,
              messageId: revision.messageId,
              threadId: providerThreadId,
              sourceTimestamp: revision.sourceTimestamp,
              direction: revision.direction,
              ...(revision.subject === undefined
                ? {}
                : { subject: revision.subject }),
              body,
              deleted: message.state === 'deleted',
            })
          : anchorRecord(anchor);
      if (anchor !== undefined) anchorCount += 1;
      const serializedRecord = canonicalJson(record);
      const rawContentHash = sha256(serializedRecord);
      const source = sourceFor(channel);
      channelCounts.set(channel, (channelCounts.get(channel) ?? 0) + 1);
      brandCounts.set(brandId, (brandCounts.get(brandId) ?? 0) + 1);
      threads.add(providerThreadId);
      return {
        schemaVersion: '1',
        workItemId: `evaluator-v2-work-${String(index + 1).padStart(4, '0')}`,
        source,
        tenantId: deterministicEvaluatorIdentityV2.tenantId,
        accountId,
        connectorSnapshot: connectorSnapshot({
          channel,
          accountId,
          snapshot: account.snapshot,
        }),
        rawReference: immutableBlobRefSchema.parse({
          schemaVersion: '1',
          tenantId: deterministicEvaluatorIdentityV2.tenantId,
          bucketRef: 'deterministic-evaluator-fixture',
          objectKey:
            anchor === undefined
              ? `synthetic/v2/${source}/${revision.messageId}`
              : `synthetic/gmail/${anchor.providerMessageId}`,
          objectVersion: rawContentHash,
          contentHash: rawContentHash,
          byteLength: new TextEncoder().encode(serializedRecord).byteLength,
          mediaType: 'application/json',
          encryptionKeyRef: 'deterministic-evaluator-fixture',
          retentionPolicyVersion: '1',
        }),
        record,
        authorizationEpoch: deterministicEvaluatorIdentityV2.authorizationEpoch,
        scopeHash: deterministicEvaluatorIdentityV2.scopeHash,
        brandIds: [brandId],
      };
    });

  const observedAccountIds = [
    ...new Set(workItems.map(({ accountId }) => accountId)),
  ];
  const observedBrandIds = [
    ...new Set(workItems.flatMap(({ brandIds }) => brandIds ?? [])),
  ];
  if (
    workItems.length !== deterministicEvaluatorIdentityV2.corpus.messageCount ||
    threads.size !== deterministicEvaluatorIdentityV2.corpus.threadCount ||
    observedAccountIds.length !==
      deterministicEvaluatorIdentityV2.corpus.accountCount ||
    observedBrandIds.length !==
      deterministicEvaluatorIdentityV2.corpus.brandCount ||
    canonicalJson(Object.fromEntries(channelCounts)) !==
      canonicalJson(hostedEvaluatorChannelCountsV2) ||
    canonicalJson(Object.fromEntries(brandCounts)) !==
      canonicalJson(hostedEvaluatorBrandCountsV2) ||
    canonicalJson(observedAccountIds) !==
      canonicalJson(deterministicEvaluatorIdentityV2.accountIds) ||
    canonicalJson(observedBrandIds) !==
      canonicalJson(deterministicEvaluatorIdentityV2.brandIds) ||
    anchorCount !== deterministicEvaluatorIdentityV2.anchorOverlays.length ||
    JSON.stringify(workItems).includes('tenant-demo-isolation')
  )
    throw new Error('HOSTED_CORPUS_IDENTITY_DRIFT');

  return Object.freeze({
    workItems: Object.freeze(workItems),
    messageCount: deterministicEvaluatorIdentityV2.corpus.messageCount,
    threadCount: deterministicEvaluatorIdentityV2.corpus.threadCount,
    accountCount: deterministicEvaluatorIdentityV2.corpus.accountCount,
    brandCount: deterministicEvaluatorIdentityV2.corpus.brandCount,
    channelCounts: hostedEvaluatorChannelCountsV2,
    brandCounts: hostedEvaluatorBrandCountsV2,
  });
}
