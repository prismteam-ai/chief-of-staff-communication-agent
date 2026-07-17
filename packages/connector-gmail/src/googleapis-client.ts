import type { EffectExecutionArtifact } from '@chief/contracts/approval';
import type {
  ConnectorAccountRef,
  ConnectorSnapshot,
} from '@chief/contracts/connectors';
import type { gmail_v1 } from 'googleapis';

import type {
  GmailHeader,
  GmailHistoryClient,
  GmailHistoryPage,
  GmailMessagePart,
  GmailPreparedSendResult,
  GmailPreparedSendResultAccepted,
  GmailProviderMessage,
  GmailProviderThread,
  GmailSendClient,
} from './types.js';

export interface GmailApiEvidenceBoundary {
  captureMessage(
    account: ConnectorAccountRef,
    message: gmail_v1.Schema$Message,
  ): Promise<{
    readonly rawBodyRef: string;
    readonly canonicalPayloadHash: string;
  }>;
  hashProviderResponse(response: unknown): string;
}

export interface GmailPreparedMimeSource {
  load(input: {
    readonly account: ConnectorAccountRef;
    readonly artifact: EffectExecutionArtifact;
  }): Promise<{
    readonly rawBase64Url: string;
    readonly renderedPayloadFingerprint: string;
    readonly threadId?: string;
  }>;
}

export interface GmailAccountSnapshotResolver {
  snapshotForAccount(account: ConnectorAccountRef): ConnectorSnapshot;
}

function requireString(
  value: string | null | undefined,
  field: string,
): string {
  if (value === undefined || value === null || value.length === 0) {
    throw new Error(`GMAIL_PROVIDER_FIELD_REQUIRED:${field}`);
  }
  return value;
}

function optionalString(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value.length === 0
    ? undefined
    : value;
}

function toHeader(header: gmail_v1.Schema$MessagePartHeader): GmailHeader {
  return {
    name: requireString(header.name, 'payload.headers.name'),
    value: requireString(header.value, 'payload.headers.value'),
  };
}

function toPart(part: gmail_v1.Schema$MessagePart): GmailMessagePart {
  const attachmentId = optionalString(part.body?.attachmentId);
  const data = optionalString(part.body?.data);
  return {
    ...(optionalString(part.partId) === undefined
      ? {}
      : { partId: optionalString(part.partId) }),
    ...(optionalString(part.mimeType) === undefined
      ? {}
      : { mimeType: optionalString(part.mimeType) }),
    ...(optionalString(part.filename) === undefined
      ? {}
      : { filename: optionalString(part.filename) }),
    headers: (part.headers ?? []).map(toHeader),
    body: {
      ...(attachmentId === undefined ? {} : { attachmentId }),
      ...(data === undefined ? {} : { data }),
      ...(part.body?.size === undefined || part.body.size === null
        ? {}
        : { size: part.body.size }),
    },
    parts: (part.parts ?? []).map(toPart),
  };
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const response: unknown = (error as { readonly response?: unknown }).response;
  if (typeof response !== 'object' || response === null) {
    return undefined;
  }
  const status: unknown = (response as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function messageIdHeader(message: gmail_v1.Schema$Message): string | undefined {
  const header = message.payload?.headers?.find(
    (candidate) => candidate.name?.toLowerCase() === 'message-id',
  );
  return optionalString(header?.value);
}

export class GoogleApisGmailClient
  implements GmailHistoryClient, GmailSendClient
{
  public constructor(
    private readonly client: gmail_v1.Gmail,
    private readonly evidence: GmailApiEvidenceBoundary,
    private readonly preparedMime: GmailPreparedMimeSource,
    private readonly snapshots: GmailAccountSnapshotResolver,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public snapshotForAccount(account: ConnectorAccountRef): ConnectorSnapshot {
    return this.snapshots.snapshotForAccount(account);
  }

  public async validateConnection(account: ConnectorAccountRef) {
    try {
      await this.client.users.getProfile({ userId: 'me' });
      return {
        account,
        health: 'healthy' as const,
        observedAt: this.now(),
        capabilitySnapshotHash:
          this.snapshots.snapshotForAccount(account).capabilitySnapshotHash,
      };
    } catch {
      return {
        account,
        health: 'failed' as const,
        observedAt: this.now(),
        capabilitySnapshotHash:
          this.snapshots.snapshotForAccount(account).capabilitySnapshotHash,
        errorCode: 'gmail_connection_validation_failed',
      };
    }
  }

  public async getCurrentHistoryId(_account: ConnectorAccountRef) {
    const response = await this.client.users.getProfile({ userId: 'me' });
    return {
      historyId: requireString(response.data.historyId, 'profile.historyId'),
      providerResponseHash: this.evidence.hashProviderResponse(response.data),
    };
  }

  public async listMessagesForBackfill(input: {
    readonly account: ConnectorAccountRef;
    readonly pageToken?: string;
    readonly maxResults: number;
  }) {
    const response = await this.client.users.messages.list({
      userId: 'me',
      maxResults: input.maxResults,
      includeSpamTrash: true,
      ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
    });
    return {
      messages: (response.data.messages ?? []).map((message) => ({
        id: requireString(message.id, 'backfill.message.id'),
        threadId: requireString(message.threadId, 'backfill.message.threadId'),
      })),
      ...(optionalString(response.data.nextPageToken) === undefined
        ? {}
        : { nextPageToken: optionalString(response.data.nextPageToken) }),
      providerResponseHash: this.evidence.hashProviderResponse(response.data),
    };
  }

  public async listHistory(input: {
    readonly account: ConnectorAccountRef;
    readonly startHistoryId: string;
    readonly pageToken?: string;
    readonly maxResults: number;
  }): Promise<GmailHistoryPage> {
    const response = await this.client.users.history.list({
      userId: 'me',
      startHistoryId: input.startHistoryId,
      historyTypes: ['messageAdded'],
      maxResults: input.maxResults,
      ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
    });
    return {
      history: (response.data.history ?? []).map((record) => ({
        id: requireString(record.id, 'history.id'),
        messagesAdded: (record.messagesAdded ?? []).map((added) => ({
          message: {
            id: requireString(added.message?.id, 'history.message.id'),
            threadId: requireString(
              added.message?.threadId,
              'history.message.threadId',
            ),
          },
        })),
      })),
      historyId: requireString(response.data.historyId, 'historyId'),
      ...(optionalString(response.data.nextPageToken) === undefined
        ? {}
        : { nextPageToken: optionalString(response.data.nextPageToken) }),
      providerResponseHash: this.evidence.hashProviderResponse(response.data),
    };
  }

  private async toProviderMessage(
    account: ConnectorAccountRef,
    message: gmail_v1.Schema$Message,
  ): Promise<GmailProviderMessage> {
    const captured = await this.evidence.captureMessage(account, message);
    if (message.payload === undefined || message.payload === null) {
      throw new Error('GMAIL_PROVIDER_FIELD_REQUIRED:payload');
    }
    return {
      id: requireString(message.id, 'message.id'),
      threadId: requireString(message.threadId, 'message.threadId'),
      ...(optionalString(message.historyId) === undefined
        ? {}
        : { historyId: optionalString(message.historyId) }),
      ...(optionalString(message.internalDate) === undefined
        ? {}
        : { internalDate: optionalString(message.internalDate) }),
      labelIds: (message.labelIds ?? []).filter(
        (label): label is string => label !== null,
      ),
      payload: toPart(message.payload),
      ...(message.sizeEstimate === undefined || message.sizeEstimate === null
        ? {}
        : { sizeEstimate: message.sizeEstimate }),
      ...captured,
    };
  }

  public async getMessage(
    account: ConnectorAccountRef,
    providerMessageId: string,
  ): Promise<GmailProviderMessage> {
    const response = await this.client.users.messages.get({
      userId: 'me',
      id: providerMessageId,
      format: 'full',
    });
    return this.toProviderMessage(account, response.data);
  }

  public async getThread(
    account: ConnectorAccountRef,
    providerThreadId: string,
  ): Promise<GmailProviderThread> {
    const response = await this.client.users.threads.get({
      userId: 'me',
      id: providerThreadId,
      format: 'full',
    });
    const messages = await Promise.all(
      (response.data.messages ?? []).map((message) =>
        this.toProviderMessage(account, message),
      ),
    );
    return {
      id: requireString(response.data.id, 'thread.id'),
      ...(optionalString(response.data.historyId) === undefined
        ? {}
        : { historyId: optionalString(response.data.historyId) }),
      messages,
    };
  }

  public async sendPrepared(
    account: ConnectorAccountRef,
    artifact: EffectExecutionArtifact,
  ): Promise<GmailPreparedSendResult> {
    const prepared = await this.preparedMime.load({ account, artifact });
    if (
      prepared.renderedPayloadFingerprint !==
      artifact.renderedPayloadFingerprint
    ) {
      throw new Error('GMAIL_PREPARED_PAYLOAD_FINGERPRINT_MISMATCH');
    }
    try {
      const response = await this.client.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: prepared.rawBase64Url,
          ...(prepared.threadId === undefined
            ? {}
            : { threadId: prepared.threadId }),
        },
      });
      const responseHash = this.evidence.hashProviderResponse(response.data);
      const providerMessageId = optionalString(response.data.id);
      const providerThreadId = optionalString(response.data.threadId);
      if (providerMessageId === undefined || providerThreadId === undefined) {
        return {
          outcome: 'acceptance_unknown',
          providerResponseHash: responseHash,
          reasonCode: 'gmail_send_response_missing_correlation',
          observedAt: this.now(),
        };
      }
      return {
        outcome: 'accepted',
        providerMessageId,
        providerThreadId,
        providerResponseHash: responseHash,
        observedAt: this.now(),
      };
    } catch (error) {
      const status = httpStatus(error);
      const providerResponseHash = this.evidence.hashProviderResponse({
        errorClass: 'gmail_send_error',
        ...(status === undefined ? {} : { status }),
      });
      if (status !== undefined && status >= 400 && status < 500) {
        return {
          outcome: 'rejected',
          providerResponseHash,
          reasonCode: `gmail_http_${status}`,
          observedAt: this.now(),
        };
      }
      return {
        outcome: 'acceptance_unknown',
        providerResponseHash,
        reasonCode: 'gmail_send_transport_ambiguous',
        observedAt: this.now(),
      };
    }
  }

  public async findSentByClientCorrelation(input: {
    readonly account: ConnectorAccountRef;
    readonly artifact: EffectExecutionArtifact;
    readonly maxProviderQueries: number;
  }): Promise<readonly GmailPreparedSendResultAccepted[]> {
    if (input.maxProviderQueries < 2) {
      return [];
    }
    const response = await this.client.users.messages.list({
      userId: 'me',
      q: `in:sent rfc822msgid:${input.artifact.clientCorrelation.value}`,
      maxResults: Math.min(input.maxProviderQueries - 1, 10),
      includeSpamTrash: false,
    });
    const candidates = response.data.messages ?? [];
    const matches: GmailPreparedSendResultAccepted[] = [];
    for (const candidate of candidates.slice(0, input.maxProviderQueries - 1)) {
      const id = requireString(candidate.id, 'sent.message.id');
      const detail = await this.client.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['Message-ID'],
      });
      if (
        messageIdHeader(detail.data) !== input.artifact.clientCorrelation.value
      ) {
        continue;
      }
      matches.push({
        outcome: 'accepted',
        providerMessageId: requireString(detail.data.id, 'sent.message.id'),
        providerThreadId: requireString(
          detail.data.threadId,
          'sent.message.threadId',
        ),
        providerResponseHash: this.evidence.hashProviderResponse(detail.data),
        observedAt: this.now(),
      });
    }
    return matches;
  }
}
