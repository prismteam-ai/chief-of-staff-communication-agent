import { createHash } from 'node:crypto';

import {
  accountIdSchema,
  attachmentSchema,
  brandIdSchema,
  connectorSnapshotSchema,
  immutableBlobRefSchema,
  messageIdSchema,
  messageRevisionIdSchema,
  messageRevisionSchema,
  messageSchema,
  providerThreadSchema,
  sha256Schema,
  tenantIdSchema,
  threadIdSchema,
  timestampSchema,
  topicLinkSchema,
  type KeyedDigestValue,
  type MessageRevision,
  type SyncCheckpoint,
  type TopicLink,
} from '@chief/contracts';
import { advanceSyncCheckpoint, DomainInvariantError } from '@chief/domain';
import type {
  KeyCodec,
  SensitiveIdentifierKind,
} from '@chief/persistence-dynamodb';
import type {
  RetrievalStagingRegistrar,
  StagedRetrievalMutationV1,
} from '@chief/rag';

import { toAuthoredSegment } from './authored-segment.js';
import type {
  AnswerState,
  AsanaRecord,
  CanonicalAsanaWrite,
  CanonicalCommunicationWrite,
  CanonicalWrite,
  IngestionEvent,
  IngestionResult,
  IngestionSource,
  IngestionStore,
  IngestionWorkItem,
  ProviderAttachmentInput,
  ProviderRecord,
  RetrievalMutationSink,
  SourceCounts,
  ThreadMessageFact,
} from './types.js';

const MAX_WORK_ITEMS = 1_000;
const MAX_ATTACHMENTS = 25;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const SLA_MILLISECONDS = 5 * 60 * 1_000;

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'been',
  'before',
  'could',
  'from',
  'have',
  'into',
  'just',
  'more',
  'need',
  'please',
  'that',
  'their',
  'them',
  'then',
  'there',
  'this',
  'what',
  'when',
  'where',
  'which',
  'with',
  'would',
  'your',
]);

export class IngestionValidationError extends Error {
  public constructor(public readonly reasonCode: string) {
    super(reasonCode);
    this.name = 'IngestionValidationError';
  }
}

interface NormalizedRecord {
  readonly providerMessageId: string;
  readonly providerThreadId: string;
  readonly channel: string;
  readonly sourceTimestamp: string;
  readonly direction: 'inbound' | 'outbound';
  readonly sender: string;
  readonly recipients: readonly string[];
  readonly subject?: string;
  readonly body: string;
  readonly attachments: readonly ProviderAttachmentInput[];
  readonly deleted: boolean;
}

interface MutableCounts {
  source: IngestionSource;
  received: number;
  created: number;
  updated: number;
  duplicates: number;
  deleted: number;
  quarantined: number;
  checkpointAdvanced: number;
  retrievalUpdated: number;
  projectionFailed: number;
  projectionRecoveryQueued: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableId(prefix: string, values: readonly unknown[]): string {
  return `${prefix}_${sha256(values).slice(0, 40)}`;
}

function header(
  record: {
    readonly headers: Readonly<Record<string, string | readonly string[]>>;
  },
  name: string,
): readonly string[] {
  const entry = Object.entries(record.headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  if (entry === undefined) return [];
  return typeof entry === 'string' ? [entry] : entry;
}

function firstHeader(
  record: {
    readonly headers: Readonly<Record<string, string | readonly string[]>>;
  },
  name: string,
): string | undefined {
  return header(record, name)[0];
}

function splitAddresses(values: readonly string[]): readonly string[] {
  return values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function textFromHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/\s+/gu, ' ')
    .trim();
}

function requireText(value: string | undefined, code: string): string {
  if (value === undefined || value.trim().length === 0)
    throw new IngestionValidationError(code);
  return value;
}

function validateAttachments(
  attachments: readonly ProviderAttachmentInput[],
): void {
  if (attachments.length > MAX_ATTACHMENTS)
    throw new IngestionValidationError('ATTACHMENT_COUNT_LIMIT');
  let total = 0;
  for (const attachment of attachments) {
    if (
      !Number.isSafeInteger(attachment.byteLength) ||
      attachment.byteLength < 0 ||
      attachment.byteLength > MAX_ATTACHMENT_BYTES
    ) {
      throw new IngestionValidationError('ATTACHMENT_SIZE_LIMIT');
    }
    total += attachment.byteLength;
    sha256Schema.parse(attachment.contentHash);
    immutableBlobRefSchema.parse(attachment.blob);
  }
  if (total > MAX_TOTAL_ATTACHMENT_BYTES)
    throw new IngestionValidationError('ATTACHMENT_TOTAL_SIZE_LIMIT');
}

function normalizeProviderRecord(
  record: Exclude<ProviderRecord, AsanaRecord>,
): NormalizedRecord {
  switch (record.kind) {
    case 'gmail': {
      const body =
        record.textBody ??
        (record.htmlBody === undefined
          ? undefined
          : textFromHtml(record.htmlBody));
      return {
        providerMessageId: record.id,
        providerThreadId: record.threadId,
        channel: 'email',
        sourceTimestamp: new Date(Number(record.internalDate)).toISOString(),
        direction: record.direction,
        sender: requireText(firstHeader(record, 'from'), 'GMAIL_FROM_REQUIRED'),
        recipients: splitAddresses([
          ...header(record, 'to'),
          ...header(record, 'cc'),
        ]),
        ...(firstHeader(record, 'subject') === undefined
          ? {}
          : { subject: firstHeader(record, 'subject') }),
        body: body ?? '',
        attachments: record.attachments,
        deleted: record.deleted === true,
      };
    }
    case 'microsoft_graph':
      return {
        providerMessageId: record.id,
        providerThreadId: record.conversationId,
        channel: 'email',
        sourceTimestamp: record.receivedDateTime,
        direction: record.direction,
        sender: record.from,
        recipients: [...record.toRecipients, ...(record.ccRecipients ?? [])],
        ...(record.subject === undefined ? {} : { subject: record.subject }),
        body:
          record.body.contentType === 'html'
            ? textFromHtml(record.body.content)
            : record.body.content,
        attachments: record.attachments,
        deleted: record.removed === true,
      };
    case 'imap':
      return {
        providerMessageId: `${record.uidValidity}:${String(record.uid)}:${record.messageId}`,
        providerThreadId: record.inReplyTo ?? record.messageId,
        channel: 'email',
        sourceTimestamp: record.date,
        direction: record.direction,
        sender: record.from,
        recipients: record.to,
        ...(record.subject === undefined ? {} : { subject: record.subject }),
        body:
          record.textBody ??
          (record.htmlBody === undefined ? '' : textFromHtml(record.htmlBody)),
        attachments: record.attachments,
        deleted: record.expunged === true,
      };
    case 'twilio_sms':
    case 'twilio_whatsapp':
      return {
        providerMessageId: record.sid,
        providerThreadId:
          record.conversationId ?? stableId('twc', [record.from, record.to]),
        channel: record.kind === 'twilio_sms' ? 'sms' : 'whatsapp',
        sourceTimestamp: record.dateCreated,
        direction: record.direction,
        sender: record.from,
        recipients: [record.to],
        body: record.body,
        attachments: record.media,
        deleted: record.revoked === true,
      };
    case 'x':
      return {
        providerMessageId: record.eventId,
        providerThreadId: record.conversationId,
        channel: 'x_dm',
        sourceTimestamp: record.createdAt,
        direction: record.direction,
        sender: record.senderId,
        recipients: [record.recipientId],
        body: record.text,
        attachments: [],
        deleted: record.deleted === true,
      };
    case 'linkedin_archive':
      return {
        providerMessageId: record.messageId,
        providerThreadId: record.conversationId,
        channel: 'linkedin_archive',
        sourceTimestamp: record.sourceTimestamp,
        direction: record.direction,
        sender: record.senderParticipantId,
        recipients: record.recipientParticipantIds,
        ...(record.subject === undefined ? {} : { subject: record.subject }),
        body: record.content,
        attachments: record.attachments,
        deleted: false,
      };
    case 'demo':
      return {
        providerMessageId: record.id,
        providerThreadId: record.threadId,
        channel: record.channel,
        sourceTimestamp: record.sourceTimestamp,
        direction: record.direction,
        sender: record.sender,
        recipients: record.recipients,
        ...(record.subject === undefined ? {} : { subject: record.subject }),
        body: record.body,
        attachments: record.attachments,
        deleted: record.deleted === true,
      };
  }
}

function identityKind(source: IngestionSource): SensitiveIdentifierKind {
  if (source === 'gmail' || source === 'microsoft_graph' || source === 'imap')
    return 'email';
  if (source === 'twilio_sms' || source === 'twilio_whatsapp') return 'phone';
  if (source === 'x') return 'handle';
  return 'opaque';
}

function topicTerms(value: string): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        value
          .normalize('NFKC')
          .toLowerCase()
          .match(/[\p{L}\p{N}][\p{L}\p{N}_-]{3,}/gu) ?? [],
      ),
    ]
      .filter((term) => !STOP_WORDS.has(term))
      .sort()
      .slice(0, 20),
  );
}

function computeAnswerState(input: {
  readonly threadId: string;
  readonly facts: readonly ThreadMessageFact[];
  readonly current: ThreadMessageFact;
  readonly computedAt: string;
}): AnswerState {
  const active = [...input.facts, input.current].filter(
    (fact) => !fact.deleted,
  );
  const inbound = active
    .filter((fact) => fact.direction === 'inbound')
    .sort((left, right) =>
      right.sourceTimestamp.localeCompare(left.sourceTimestamp),
    )[0];
  const outbound = active
    .filter((fact) => fact.direction === 'outbound')
    .sort((left, right) =>
      right.sourceTimestamp.localeCompare(left.sourceTimestamp),
    )[0];
  if (input.current.deleted && active.length === 0)
    return {
      threadId: input.threadId,
      status: 'deleted',
      computedAt: input.computedAt,
    };
  if (inbound === undefined)
    return {
      threadId: input.threadId,
      status: outbound === undefined ? 'pending' : 'answered',
      ...(outbound === undefined
        ? {}
        : { latestOutboundAt: outbound.sourceTimestamp }),
      computedAt: input.computedAt,
    };
  const deadline = new Date(
    Date.parse(inbound.sourceTimestamp) + SLA_MILLISECONDS,
  ).toISOString();
  const answered =
    outbound !== undefined &&
    outbound.sourceTimestamp >= inbound.sourceTimestamp;
  return {
    threadId: input.threadId,
    status: answered
      ? 'answered'
      : Date.parse(input.computedAt) > Date.parse(deadline)
        ? 'overdue'
        : 'pending',
    latestInboundAt: inbound.sourceTimestamp,
    ...(outbound === undefined
      ? {}
      : { latestOutboundAt: outbound.sourceTimestamp }),
    slaDeadline: deadline,
    computedAt: input.computedAt,
  };
}

function assertWorkItem(item: IngestionWorkItem): void {
  tenantIdSchema.parse(item.tenantId);
  accountIdSchema.parse(item.accountId);
  connectorSnapshotSchema.parse(item.connectorSnapshot);
  immutableBlobRefSchema.parse(item.rawReference);
  sha256Schema.parse(item.scopeHash);
  item.brandIds?.forEach((brandId) => brandIdSchema.parse(brandId));
  if (
    item.connectorSnapshot.accountId !== item.accountId ||
    item.rawReference.tenantId !== item.tenantId
  )
    throw new IngestionValidationError('SCOPE_BINDING_MISMATCH');
  if (item.source !== item.record.kind)
    throw new IngestionValidationError('SOURCE_KIND_MISMATCH');
  if (
    !Number.isSafeInteger(item.authorizationEpoch) ||
    item.authorizationEpoch < 1
  )
    throw new IngestionValidationError('AUTHORIZATION_EPOCH_INVALID');
  if (item.checkpoint !== undefined) {
    if (
      item.checkpoint.current.tenantId !== item.tenantId ||
      item.checkpoint.current.accountId !== item.accountId
    )
      throw new IngestionValidationError('CHECKPOINT_SCOPE_MISMATCH');
  }
}

async function canonicalizeCommunication(input: {
  readonly item: IngestionWorkItem;
  readonly store: IngestionStore;
  readonly keys: KeyCodec;
  readonly now: string;
}): Promise<CanonicalCommunicationWrite> {
  const record = normalizeProviderRecord(
    input.item.record as Exclude<ProviderRecord, AsanaRecord>,
  );
  timestampSchema.parse(record.sourceTimestamp);
  if (record.recipients.length === 0)
    throw new IngestionValidationError('RECIPIENT_REQUIRED');
  validateAttachments(record.attachments);
  const kind = identityKind(input.item.source);
  const senderDigest = input.keys.digest({
    tenantId: input.item.tenantId,
    purpose: 'identity',
    kind,
    value: record.sender,
  });
  const recipientDigests = record.recipients.map((value) =>
    input.keys.digest({
      tenantId: input.item.tenantId,
      purpose: 'identity',
      kind,
      value,
    }),
  );
  const providerMessageDigest = input.keys.digest({
    tenantId: input.item.tenantId,
    purpose: 'dedupe',
    kind: 'provider_subject',
    value: `${input.item.accountId}:${record.providerMessageId}`,
  });
  const providerThreadDigest = input.keys.digest({
    tenantId: input.item.tenantId,
    purpose: 'dedupe',
    kind: 'provider_subject',
    value: `${input.item.accountId}:${record.providerThreadId}`,
  });
  const messageId = messageIdSchema.parse(
    stableId('msg', [
      input.item.tenantId,
      input.item.accountId,
      record.providerMessageId,
    ]),
  );
  const threadId = threadIdSchema.parse(
    stableId('thr', [
      input.item.tenantId,
      input.item.accountId,
      record.providerThreadId,
    ]),
  );
  const contentHash = sha256({
    record,
    raw: input.item.rawReference.contentHash,
    snapshot: input.item.connectorSnapshot,
  });
  const revisionId = messageRevisionIdSchema.parse(
    stableId('mrev', [messageId, contentHash]),
  );
  const priorFacts = await input.store.threadFacts({
    tenantId: input.item.tenantId,
    threadId,
  });
  const priorSameMessage = priorFacts.filter(
    (fact) => fact.messageId === messageId,
  );
  const revisionNumber = priorSameMessage.length + 1;
  const fullBody = await input.store.putBody({
    tenantId: input.item.tenantId,
    body: record.body,
    contentHash: sha256Text(record.body),
    mediaType: 'text/plain; charset=utf-8',
  });
  const attachmentIds = record.attachments.map((attachment) =>
    stableId('att', [
      messageId,
      attachment.providerAttachmentId,
      attachment.contentHash,
    ]),
  );
  const attachments = record.attachments.map((attachment, index) =>
    attachmentSchema.parse({
      schemaVersion: '1',
      tenantId: input.item.tenantId,
      attachmentId: attachmentIds[index],
      sourceMessageRevisionId: revisionId,
      providerAttachmentIdDigest: input.keys.digest({
        tenantId: input.item.tenantId,
        purpose: 'dedupe',
        kind: 'provider_subject',
        value: `${record.providerMessageId}:${attachment.providerAttachmentId}`,
      }),
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
      byteLength: attachment.byteLength,
      contentHash: attachment.contentHash,
      blob: attachment.blob,
      malwareState: 'pending',
      extractionState: 'not_requested',
    }),
  );
  const currentFact: ThreadMessageFact = {
    messageId,
    revisionId,
    direction: record.direction,
    sourceTimestamp: record.sourceTimestamp,
    deleted: record.deleted,
  };
  const chronology = [...priorFacts, currentFact].sort(
    (left, right) =>
      left.sourceTimestamp.localeCompare(right.sourceTimestamp) ||
      left.revisionId.localeCompare(right.revisionId),
  );
  const latest =
    chronology.filter((fact) => !fact.deleted).at(-1) ?? currentFact;
  const revision: MessageRevision = messageRevisionSchema.parse({
    schemaVersion: '1',
    tenantId: input.item.tenantId,
    messageId,
    revisionId,
    revision: revisionNumber,
    threadId,
    connectorSnapshot: input.item.connectorSnapshot,
    providerMessageIdDigest: providerMessageDigest,
    providerThreadIdDigest: providerThreadDigest,
    direction: record.direction,
    sender: {
      identityDigest: senderDigest,
      encryptedAddressRef: `${input.item.rawReference.objectKey}#sender`,
    },
    recipients: recipientDigests.map((identityDigest, index) => ({
      identityDigest,
      encryptedAddressRef: `${input.item.rawReference.objectKey}#recipient-${String(index)}`,
    })),
    ...(record.subject === undefined ? {} : { subject: record.subject }),
    immutableProviderBody: input.item.rawReference,
    fullNormalizedBody: fullBody,
    currentAuthoredSegment: toAuthoredSegment(record.body, input.now),
    attachmentIds,
    ...(priorSameMessage.at(-1) === undefined
      ? {}
      : { supersedesRevisionId: priorSameMessage.at(-1)?.revisionId }),
    sourceTimestamp: record.sourceTimestamp,
    ingestedAt: input.now,
    contentHash,
    visibility: 'account_scoped',
  });
  const message = messageSchema.parse({
    schemaVersion: '1',
    tenantId: input.item.tenantId,
    messageId,
    threadId,
    currentRevisionId: revisionId,
    currentRevision: revisionNumber,
    direction: record.direction,
    state: record.deleted ? 'deleted' : 'active',
    createdAt: priorSameMessage[0]?.sourceTimestamp ?? record.sourceTimestamp,
    updatedAt: input.now,
  });
  const thread = providerThreadSchema.parse({
    schemaVersion: '1',
    tenantId: input.item.tenantId,
    threadId,
    connectorSnapshot: input.item.connectorSnapshot,
    providerThreadIdDigest: providerThreadDigest,
    channel: record.channel,
    participantDigests: [
      ...new Set<KeyedDigestValue>([senderDigest, ...recipientDigests]),
    ],
    ...(record.subject === undefined ? {} : { subject: record.subject }),
    latestMessageRevisionId: latest.revisionId,
    version: priorFacts.length + 1,
    sourceUpdatedAt: latest.sourceTimestamp,
    status:
      record.deleted && chronology.every((fact) => fact.deleted)
        ? 'deleted'
        : 'active',
  });
  const terms = topicTerms(`${record.subject ?? ''} ${record.body}`);
  const identities = await input.store.findIdentityCandidates({
    tenantId: input.item.tenantId,
    accountId: input.item.accountId,
    identityDigests: [senderDigest, ...recipientDigests],
  });
  const asana = await input.store.findAsanaCandidates({
    tenantId: input.item.tenantId,
    topicTerms: terms,
  });
  const links: TopicLink[] = [
    ...identities.map((candidate) =>
      topicLinkSchema.parse({
        schemaVersion: '1',
        tenantId: input.item.tenantId,
        topicLinkId: stableId('tlnk', [
          revisionId,
          'person',
          candidate.entityId,
        ]),
        revision: 1,
        communicationRef: revisionId,
        linkedEntityType: 'person',
        linkedEntityId: candidate.entityId,
        method: 'exact',
        score: 0.99,
        evidenceRefs: [candidate.evidenceRef],
        reviewState: 'candidate',
        createdAt: input.now,
      }),
    ),
    ...asana.map((candidate) =>
      topicLinkSchema.parse({
        schemaVersion: '1',
        tenantId: input.item.tenantId,
        topicLinkId: stableId('tlnk', [
          revisionId,
          'asana',
          candidate.objectId,
        ]),
        revision: 1,
        communicationRef: revisionId,
        linkedEntityType: 'asana_object',
        linkedEntityId: candidate.objectId,
        method: 'metadata',
        score: 0.75,
        evidenceRefs: [candidate.evidenceRef],
        reviewState: 'candidate',
        createdAt: input.now,
      }),
    ),
  ];
  return {
    source: input.item.source as Exclude<IngestionSource, 'asana'>,
    dedupeKey: `${providerMessageDigest}:${contentHash}`,
    contentHash,
    message,
    revision,
    thread,
    attachments,
    topicLinks: links,
    answerState: computeAnswerState({
      threadId,
      facts: priorFacts,
      current: currentFact,
      computedAt: input.now,
    }),
    retrievalText: record.deleted
      ? ''
      : `${record.subject ?? ''}\n${record.body}`.trim(),
    identityDigests: [senderDigest, ...recipientDigests],
    topicTerms: terms,
    deleted: record.deleted,
  };
}

function canonicalizeAsana(
  item: IngestionWorkItem,
  keys: KeyCodec,
): CanonicalAsanaWrite {
  const record = item.record as AsanaRecord;
  timestampSchema.parse(record.providerTimestamp);
  sha256Schema.parse(record.payloadFingerprint);
  const contentHash = sha256(record);
  return {
    source: 'asana',
    dedupeKey: stableId('asana', [
      item.tenantId,
      item.accountId,
      record.providerObjectId,
      record.providerVersion,
      contentHash,
    ]),
    contentHash,
    tenantId: item.tenantId,
    accountId: item.accountId,
    objectKind: record.objectKind,
    providerObjectId: record.providerObjectId,
    providerVersion: record.providerVersion,
    providerTimestamp: record.providerTimestamp,
    title: record.title,
    ...(record.notes === undefined ? {} : { notes: record.notes }),
    projectIds: record.projectIds,
    ...(record.assigneeIdentity === undefined
      ? {}
      : {
          assigneeIdentityDigest: keys.digest({
            tenantId: item.tenantId,
            purpose: 'identity',
            kind: 'opaque',
            value: record.assigneeIdentity,
          }),
        }),
    topicTerms: topicTerms(`${record.title} ${record.notes ?? ''}`),
    deleted: record.deleted === true,
  };
}

function nextCheckpoint(
  item: IngestionWorkItem,
  committedAt: string,
): SyncCheckpoint | undefined {
  if (item.checkpoint === undefined) return undefined;
  return advanceSyncCheckpoint({
    actorTenantId: tenantIdSchema.parse(item.tenantId),
    checkpoint: item.checkpoint.current,
    expectedCheckpointEpoch: item.checkpoint.current.checkpointEpoch,
    encryptedCursor: item.checkpoint.nextEncryptedCursor,
    sourceWatermark: item.checkpoint.sourceWatermark,
    completePage: item.checkpoint.completePage,
    canonicalWritesCommitted: true,
    eventOutboxCommitted: true,
    committedAt: timestampSchema.parse(committedAt),
  });
}

function sourceStatus(counts: MutableCounts): SourceCounts['status'] {
  if (counts.quarantined === counts.received) return 'failed';
  return counts.quarantined > 0 || counts.projectionFailed > 0
    ? 'partial'
    : 'complete';
}

function safeReasonCode(error: unknown): string {
  if (error instanceof IngestionValidationError) return error.reasonCode;
  if (error instanceof DomainInvariantError) return error.code;
  if (error instanceof Error && error.name === 'ZodError')
    return 'SCHEMA_VALIDATION_FAILED';
  return 'INGESTION_PROCESSING_FAILED';
}

export class CanonicalIngestionPipeline {
  public constructor(
    private readonly dependencies: {
      readonly store: IngestionStore;
      readonly keyCodec: KeyCodec;
      readonly retrievalSink: RetrievalMutationSink;
      readonly retrievalRegistrar: RetrievalStagingRegistrar;
      readonly now?: () => Date;
    },
  ) {}

  public async recoverProjection(
    manifest: StagedRetrievalMutationV1,
  ): Promise<void> {
    await this.dependencies.retrievalRegistrar.register(manifest);
  }

  public async process(event: IngestionEvent): Promise<IngestionResult> {
    const startedAt = this.dependencies.now?.() ?? new Date();
    if (event.schemaVersion !== '1' || event.invocationId.trim().length === 0)
      throw new IngestionValidationError('EVENT_INVALID');
    timestampSchema.parse(event.receivedAt);
    if (event.workItems.length > MAX_WORK_ITEMS)
      throw new IngestionValidationError('WORK_ITEM_LIMIT');
    const counts = new Map<IngestionSource, MutableCounts>();
    for (const item of event.workItems) {
      const source = counts.get(item.source) ?? {
        source: item.source,
        received: 0,
        created: 0,
        updated: 0,
        duplicates: 0,
        deleted: 0,
        quarantined: 0,
        checkpointAdvanced: 0,
        retrievalUpdated: 0,
        projectionFailed: 0,
        projectionRecoveryQueued: 0,
      };
      source.received += 1;
      counts.set(item.source, source);
      try {
        assertWorkItem(item);
        const now = (this.dependencies.now?.() ?? new Date()).toISOString();
        const canonical: CanonicalWrite =
          item.record.kind === 'asana'
            ? canonicalizeAsana(item, this.dependencies.keyCodec)
            : await canonicalizeCommunication({
                item,
                store: this.dependencies.store,
                keys: this.dependencies.keyCodec,
                now,
              });
        const delta = await this.dependencies.retrievalSink.stage({
          workItem: item,
          canonical,
        });
        const committed = await this.dependencies.store.commit({
          workItem: item,
          canonical,
          ...(item.checkpoint === undefined
            ? {}
            : { checkpoint: nextCheckpoint(item, now) }),
          ...(delta === undefined ? {} : { retrievalMutation: delta }),
        });
        if (committed.status === 'duplicate') source.duplicates += 1;
        else if (committed.status === 'updated') source.updated += 1;
        else if (committed.status === 'deleted') source.deleted += 1;
        else source.created += 1;
        if (item.checkpoint !== undefined && committed.status !== 'duplicate')
          source.checkpointAdvanced += 1;
        if (delta !== undefined && committed.status !== 'duplicate') {
          try {
            await this.dependencies.retrievalRegistrar.register(delta);
            source.retrievalUpdated += 1;
          } catch {
            source.projectionFailed += 1;
            source.projectionRecoveryQueued += 1;
          }
        }
      } catch (error) {
        source.quarantined += 1;
        const reasonCode = safeReasonCode(error);
        await this.dependencies.store.quarantine({
          workItem: item,
          reasonCode,
          detailHash: sha256(
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
    }
    const completedAt = this.dependencies.now?.() ?? new Date();
    const sources = [...counts.values()]
      .sort((left, right) => left.source.localeCompare(right.source))
      .map((source) =>
        Object.freeze({ ...source, status: sourceStatus(source) }),
      );
    const quarantined = sources.reduce(
      (total, source) => total + source.quarantined,
      0,
    );
    const projectionFailures = sources.reduce(
      (total, source) => total + source.projectionFailed,
      0,
    );
    const projectionRecoveriesQueued = sources.reduce(
      (total, source) => total + source.projectionRecoveryQueued,
      0,
    );
    const processed = event.workItems.length - quarantined;
    return Object.freeze({
      invocationId: event.invocationId,
      status:
        event.workItems.length > 0 && quarantined === event.workItems.length
          ? 'failed'
          : quarantined > 0 || projectionFailures > 0
            ? 'partial'
            : 'complete',
      received: event.workItems.length,
      processed,
      quarantined,
      projectionFailures,
      projectionRecoveriesQueued,
      sources,
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      externalProviderCalls: 0,
    });
  }
}
