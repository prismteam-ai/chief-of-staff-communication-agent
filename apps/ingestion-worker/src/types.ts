import type {
  Attachment,
  ConnectorSnapshot,
  ImmutableBlobRef,
  Message,
  MessageRevision,
  ProviderThread,
  RetrievalDeltaManifest,
  SyncCheckpoint,
  TopicLink,
} from '@chief/contracts';

export type IngestionSource =
  | 'gmail'
  | 'microsoft_graph'
  | 'imap'
  | 'twilio_sms'
  | 'twilio_whatsapp'
  | 'x'
  | 'linkedin_archive'
  | 'asana'
  | 'demo';

export interface ProviderAttachmentInput {
  readonly providerAttachmentId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentHash: string;
  readonly blob: ImmutableBlobRef;
}

export interface GmailRecord {
  readonly kind: 'gmail';
  readonly id: string;
  readonly threadId: string;
  readonly internalDate: string;
  readonly labels: readonly string[];
  readonly direction: 'inbound' | 'outbound';
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly textBody?: string;
  readonly htmlBody?: string;
  readonly attachments: readonly ProviderAttachmentInput[];
  readonly deleted?: boolean;
}

export interface GraphRecord {
  readonly kind: 'microsoft_graph';
  readonly id: string;
  readonly conversationId: string;
  readonly receivedDateTime: string;
  readonly direction: 'inbound' | 'outbound';
  readonly subject?: string;
  readonly body: {
    readonly contentType: 'text' | 'html';
    readonly content: string;
  };
  readonly from: string;
  readonly toRecipients: readonly string[];
  readonly ccRecipients?: readonly string[];
  readonly attachments: readonly ProviderAttachmentInput[];
  readonly removed?: boolean;
}

export interface ImapRecord {
  readonly kind: 'imap';
  readonly uidValidity: string;
  readonly uid: number;
  readonly mailbox: string;
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly date: string;
  readonly direction: 'inbound' | 'outbound';
  readonly subject?: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly textBody?: string;
  readonly htmlBody?: string;
  readonly attachments: readonly ProviderAttachmentInput[];
  readonly expunged?: boolean;
}

export interface TwilioRecord {
  readonly kind: 'twilio_sms' | 'twilio_whatsapp';
  readonly sid: string;
  readonly conversationId?: string;
  readonly dateCreated: string;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly direction: 'inbound' | 'outbound';
  readonly media: readonly ProviderAttachmentInput[];
  readonly revoked?: boolean;
}

export interface XRecord {
  readonly kind: 'x';
  readonly eventId: string;
  readonly conversationId: string;
  readonly createdAt: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly text: string;
  readonly direction: 'inbound' | 'outbound';
  readonly deleted?: boolean;
}

export interface LinkedinArchiveRecord {
  readonly kind: 'linkedin_archive';
  readonly messageId: string;
  readonly conversationId: string;
  readonly sourceTimestamp: string;
  readonly senderParticipantId: string;
  readonly recipientParticipantIds: readonly string[];
  readonly subject?: string;
  readonly content: string;
  readonly direction: 'inbound' | 'outbound';
  readonly attachments: readonly ProviderAttachmentInput[];
  readonly sourceRowSha256: string;
}

export interface DemoRecord {
  readonly kind: 'demo';
  readonly id: string;
  readonly threadId: string;
  readonly channel: string;
  readonly sourceTimestamp: string;
  readonly direction: 'inbound' | 'outbound';
  readonly sender: string;
  readonly recipients: readonly string[];
  readonly subject?: string;
  readonly body: string;
  readonly attachments: readonly ProviderAttachmentInput[];
  readonly deleted?: boolean;
}

export interface AsanaRecord {
  readonly kind: 'asana';
  readonly objectKind: 'task' | 'project' | 'milestone' | 'comment';
  readonly providerObjectId: string;
  readonly providerVersion: string;
  readonly providerTimestamp: string;
  readonly payloadFingerprint: string;
  readonly title: string;
  readonly notes?: string;
  readonly projectIds: readonly string[];
  readonly assigneeIdentity?: string;
  readonly deleted?: boolean;
}

export type ProviderRecord =
  | GmailRecord
  | GraphRecord
  | ImapRecord
  | TwilioRecord
  | XRecord
  | LinkedinArchiveRecord
  | DemoRecord
  | AsanaRecord;

export interface CheckpointCommitInput {
  readonly current: SyncCheckpoint;
  readonly nextEncryptedCursor: string;
  readonly sourceWatermark: string;
  readonly completePage: number;
}

export interface IngestionWorkItem {
  readonly schemaVersion: '1';
  readonly workItemId: string;
  readonly source: IngestionSource;
  readonly tenantId: string;
  readonly accountId: string;
  readonly connectorSnapshot: ConnectorSnapshot;
  readonly rawReference: ImmutableBlobRef;
  readonly record: ProviderRecord;
  readonly checkpoint?: CheckpointCommitInput;
  readonly authorizationEpoch: number;
  readonly scopeHash: string;
  readonly brandIds?: readonly string[];
}

export interface IngestionEvent {
  readonly schemaVersion: '1';
  readonly invocationId: string;
  readonly receivedAt: string;
  readonly workItems: readonly IngestionWorkItem[];
}

export interface AuthoredSegmentResult {
  readonly authoredText: string;
  readonly boundaries: readonly {
    readonly kind: 'authored' | 'quote' | 'forward' | 'signature';
    readonly start: number;
    readonly end: number;
  }[];
  readonly confidence: number;
  readonly ambiguityReasons: readonly string[];
  readonly localeMarkers: readonly string[];
}

export interface CanonicalCommunicationWrite {
  readonly source: Exclude<IngestionSource, 'asana'>;
  readonly dedupeKey: string;
  readonly contentHash: string;
  readonly message: Message;
  readonly revision: MessageRevision;
  readonly thread: ProviderThread;
  readonly attachments: readonly Attachment[];
  readonly topicLinks: readonly TopicLink[];
  readonly answerState: AnswerState;
  readonly retrievalText: string;
  readonly identityDigests: readonly string[];
  readonly topicTerms: readonly string[];
  readonly deleted: boolean;
}

export interface CanonicalAsanaWrite {
  readonly source: 'asana';
  readonly dedupeKey: string;
  readonly contentHash: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly objectKind: AsanaRecord['objectKind'];
  readonly providerObjectId: string;
  readonly providerVersion: string;
  readonly providerTimestamp: string;
  readonly title: string;
  readonly notes?: string;
  readonly projectIds: readonly string[];
  readonly assigneeIdentityDigest?: string;
  readonly topicTerms: readonly string[];
  readonly deleted: boolean;
}

export type CanonicalWrite = CanonicalCommunicationWrite | CanonicalAsanaWrite;

export interface AnswerState {
  readonly threadId: string;
  readonly status: 'pending' | 'answered' | 'overdue' | 'deleted';
  readonly latestInboundAt?: string;
  readonly latestOutboundAt?: string;
  readonly slaDeadline?: string;
  readonly computedAt: string;
}

export interface CommitResult {
  readonly status: 'created' | 'duplicate' | 'updated' | 'deleted';
}

export interface ThreadMessageFact {
  readonly messageId: string;
  readonly revisionId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly sourceTimestamp: string;
  readonly deleted: boolean;
}

export interface IngestionStore {
  putBody(input: {
    readonly tenantId: string;
    readonly body: string;
    readonly contentHash: string;
    readonly mediaType: string;
  }): Promise<ImmutableBlobRef>;
  findIdentityCandidates(input: {
    readonly tenantId: string;
    readonly accountId: string;
    readonly identityDigests: readonly string[];
  }): Promise<
    readonly { readonly entityId: string; readonly evidenceRef: string }[]
  >;
  findAsanaCandidates(input: {
    readonly tenantId: string;
    readonly topicTerms: readonly string[];
  }): Promise<
    readonly { readonly objectId: string; readonly evidenceRef: string }[]
  >;
  threadFacts(input: {
    readonly tenantId: string;
    readonly threadId: string;
  }): Promise<readonly ThreadMessageFact[]>;
  commit(input: {
    readonly workItem: IngestionWorkItem;
    readonly canonical: CanonicalWrite;
    readonly checkpoint?: SyncCheckpoint;
    readonly retrievalDelta?: RetrievalDeltaManifest;
  }): Promise<CommitResult>;
  quarantine(input: {
    readonly workItem: IngestionWorkItem;
    readonly reasonCode: string;
    readonly detailHash: string;
  }): Promise<void>;
}

export interface RetrievalMutationSink {
  stage(input: {
    readonly workItem: IngestionWorkItem;
    readonly canonical: CanonicalWrite;
  }): Promise<RetrievalDeltaManifest | undefined>;
}

export interface SourceCounts {
  readonly source: IngestionSource;
  readonly received: number;
  readonly created: number;
  readonly updated: number;
  readonly duplicates: number;
  readonly deleted: number;
  readonly quarantined: number;
  readonly checkpointAdvanced: number;
  readonly retrievalUpdated: number;
  readonly projectionFailed: number;
  readonly projectionRecoveryQueued: number;
  readonly status: 'complete' | 'partial' | 'failed';
}

export interface IngestionResult {
  readonly invocationId: string;
  readonly status: 'complete' | 'partial' | 'failed';
  readonly received: number;
  readonly processed: number;
  readonly quarantined: number;
  readonly projectionFailures: number;
  readonly projectionRecoveriesQueued: number;
  readonly sources: readonly SourceCounts[];
  readonly durationMs: number;
  readonly externalProviderCalls: 0;
}
