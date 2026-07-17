import type {
  ConnectorAccount,
  ConnectorAccountRef,
  ConnectorSnapshot,
} from '@chief/contracts/connectors';

export const GRAPH_IMMUTABLE_ID_HEADER = Object.freeze({
  Prefer: 'IdType="ImmutableId"',
});

export interface GraphEmailAddress {
  readonly name?: string;
  readonly address: string;
}

export interface GraphRecipient {
  readonly emailAddress: GraphEmailAddress;
}

export interface GraphItemBody {
  readonly contentType: 'text' | 'html';
  readonly content: string;
}

export interface GraphAttachment {
  readonly '@odata.type': string;
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly isInline: boolean;
  readonly contentId?: string;
  readonly contentBytes?: string;
}

export interface GraphMessage {
  readonly '@odata.etag'?: string;
  readonly id: string;
  readonly conversationId: string;
  readonly conversationIndex?: string;
  readonly internetMessageId?: string;
  readonly subject: string;
  readonly bodyPreview: string;
  readonly body: GraphItemBody;
  readonly from?: GraphRecipient;
  readonly sender?: GraphRecipient;
  readonly toRecipients: readonly GraphRecipient[];
  readonly ccRecipients: readonly GraphRecipient[];
  readonly bccRecipients: readonly GraphRecipient[];
  readonly replyTo: readonly GraphRecipient[];
  readonly receivedDateTime?: string;
  readonly sentDateTime?: string;
  readonly lastModifiedDateTime: string;
  readonly parentFolderId?: string;
  readonly isDraft: boolean;
  readonly isRead: boolean;
  readonly hasAttachments: boolean;
  readonly attachments?: readonly GraphAttachment[];
  readonly internetMessageHeaders?: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
  readonly '@removed'?: { readonly reason: 'changed' | 'deleted' };
}

export interface GraphDeltaResponse {
  readonly '@odata.context': string;
  readonly value: readonly GraphMessage[];
  readonly '@odata.nextLink'?: string;
  readonly '@odata.deltaLink'?: string;
}

export interface GraphConnectorFixtureContext {
  readonly account: ConnectorAccount;
  readonly accountRef: ConnectorAccountRef;
  readonly snapshot: ConnectorSnapshot;
}

export interface GraphNotification {
  readonly subscriptionId: string;
  readonly subscriptionExpirationDateTime: string;
  readonly changeType?: 'created' | 'updated' | 'deleted';
  readonly lifecycleEvent?:
    'reauthorizationRequired' | 'subscriptionRemoved' | 'missed';
  readonly resource: string;
  readonly clientState?: string;
  readonly tenantId?: string;
  readonly resourceData?: {
    readonly '@odata.type'?: string;
    readonly '@odata.id'?: string;
    readonly '@odata.etag'?: string;
    readonly id?: string;
  };
}

export interface GraphNotificationCollection {
  readonly value: readonly GraphNotification[];
  readonly validationTokens?: readonly string[];
}
