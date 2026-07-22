import type {
  EffectExecutionArtifact,
  ProviderSendResult,
  ReconcileSendRequest,
} from '@chief/contracts/approval';
import type {
  AuthorizationCallback,
  ConnectionHealth,
  ConnectorAccount,
  ConnectorAccountRef,
  ConnectorSnapshot,
  PollRequest,
} from '@chief/contracts/connectors';

export interface GmailHeader {
  readonly name: string;
  readonly value: string;
}

export interface GmailMessagePartBody {
  readonly attachmentId?: string;
  readonly data?: string;
  readonly size?: number;
}

export interface GmailMessagePart {
  readonly partId?: string;
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: readonly GmailHeader[];
  readonly body?: GmailMessagePartBody;
  readonly parts?: readonly GmailMessagePart[];
}

export interface GmailProviderMessage {
  readonly id: string;
  readonly threadId: string;
  readonly historyId?: string;
  readonly internalDate?: string;
  readonly labelIds?: readonly string[];
  readonly payload: GmailMessagePart;
  readonly sizeEstimate?: number;
  readonly rawBodyRef: string;
  readonly canonicalPayloadHash: string;
}

export interface GmailProviderThread {
  readonly id: string;
  readonly historyId?: string;
  readonly messages: readonly GmailProviderMessage[];
}

export interface GmailHistoryRecord {
  readonly id: string;
  readonly messagesAdded?: readonly {
    readonly message: Pick<GmailProviderMessage, 'id' | 'threadId'>;
  }[];
}

export interface GmailHistoryPage {
  readonly history: readonly GmailHistoryRecord[];
  readonly historyId: string;
  readonly nextPageToken?: string;
  readonly providerResponseHash: string;
}

export interface GmailBackfillPage {
  readonly messages: readonly Pick<GmailProviderMessage, 'id' | 'threadId'>[];
  readonly nextPageToken?: string;
  readonly providerResponseHash: string;
}

export interface GmailNormalizedAttachment {
  readonly attachmentId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly partId?: string;
}

export interface GmailReplyHeaders {
  readonly messageId?: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
}

export interface GmailNormalizedMessage {
  readonly providerMessageId: string;
  readonly providerThreadId: string;
  readonly historyId?: string;
  readonly sourceTimestamp: string;
  readonly from?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject?: string;
  readonly textBody?: string;
  readonly htmlBody?: string;
  readonly labels: readonly string[];
  readonly attachments: readonly GmailNormalizedAttachment[];
  readonly reply: GmailReplyHeaders;
  readonly rawBodyRef: string;
  readonly canonicalPayloadHash: string;
}

export interface GmailOAuthCompletionResult {
  readonly account: ConnectorAccount;
  readonly authorizationAudience: string;
  readonly grantedScopes: readonly string[];
}

export interface GmailOAuthGateway {
  completeAuthorization(
    callback: AuthorizationCallback,
  ): Promise<GmailOAuthCompletionResult>;
}

export interface GmailHistoryClient {
  snapshotForAccount(account: ConnectorAccountRef): ConnectorSnapshot;
  getCurrentHistoryId(account: ConnectorAccountRef): Promise<{
    readonly historyId: string;
    readonly providerResponseHash: string;
  }>;
  listMessagesForBackfill(input: {
    readonly account: ConnectorAccountRef;
    readonly pageToken?: string;
    readonly maxResults: number;
  }): Promise<GmailBackfillPage>;
  listHistory(input: {
    readonly account: ConnectorAccountRef;
    readonly startHistoryId: string;
    readonly pageToken?: string;
    readonly maxResults: number;
  }): Promise<GmailHistoryPage>;
  getMessage(
    account: ConnectorAccountRef,
    providerMessageId: string,
  ): Promise<GmailProviderMessage>;
  getThread(
    account: ConnectorAccountRef,
    providerThreadId: string,
  ): Promise<GmailProviderThread>;
  validateConnection(account: ConnectorAccountRef): Promise<ConnectionHealth>;
}

export interface GmailPreparedSendResultAccepted {
  readonly outcome: 'accepted';
  readonly providerMessageId: string;
  readonly providerThreadId: string;
  readonly providerResponseHash: string;
  readonly observedAt: string;
}

export type GmailPreparedSendResult =
  | GmailPreparedSendResultAccepted
  | Exclude<ProviderSendResult, { readonly outcome: 'accepted' }>;

export interface GmailSendClient {
  sendPrepared(
    account: ConnectorAccountRef,
    artifact: EffectExecutionArtifact,
  ): Promise<GmailPreparedSendResult>;
  findSentByClientCorrelation(input: {
    readonly account: ConnectorAccountRef;
    readonly artifact: EffectExecutionArtifact;
    readonly maxProviderQueries: number;
  }): Promise<readonly GmailPreparedSendResultAccepted[]>;
}

export interface GmailCursorCodec {
  decodeHistoryCursor(request: PollRequest): {
    readonly historyId: string;
    readonly pageToken?: string;
    readonly latestHistoryId?: string;
  };
  encodeHistoryCursor(cursor: {
    readonly historyId: string;
    readonly pageToken?: string;
    readonly latestHistoryId?: string;
  }): string;
}

export interface GmailConnectorDependencies {
  readonly oauth: GmailOAuthGateway;
  readonly history: GmailHistoryClient;
  readonly send: GmailSendClient;
  readonly cursorCodec: GmailCursorCodec;
  readonly oauthClientId: string;
  readonly authorizationEndpoint?: string;
  readonly authorizationTtlSeconds?: number;
  readonly now?: () => string;
}

export interface GmailReconciliationPolicy {
  readonly strategy: 'gmail_sent_rfc_message_id';
  readonly strategyVersion: '1';
}

export type GmailReconcileRequest = ReconcileSendRequest;
