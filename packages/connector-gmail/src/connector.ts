import type { OAuthCommunicationConnector } from '@chief/connector-core';
import type {
  AuthorizationCallback,
  AuthorizationInput,
  ConnectorAccount,
  ConnectorAccountRef,
  PollRequest,
  ProviderMessageRef,
  ProviderThreadRef,
  SyncPage,
} from '@chief/contracts/connectors';

import {
  gmailConnectorDescriptor,
  GMAIL_AUTHORIZATION_AUDIENCE,
  GMAIL_CONNECTOR_ID,
  GMAIL_DESCRIPTOR_VERSION,
} from './descriptor.js';
import { toCanonicalEnvelope } from './normalization.js';
import { beginGmailAuthorization, GMAIL_OAUTH_SCOPES } from './oauth.js';
import { reconcileGmailEffect, sendGmailEffect } from './send.js';
import type { GmailConnectorDependencies } from './types.js';

const DEFAULT_AUTHORIZATION_ENDPOINT =
  'https://accounts.google.com/o/oauth2/v2/auth';

export class GmailHistoryResetRequiredError extends Error {
  public constructor() {
    super('GMAIL_HISTORY_RESET_REQUIRED');
    this.name = 'GmailHistoryResetRequiredError';
  }
}

function accountRef(account: ConnectorAccount): ConnectorAccountRef {
  return {
    tenantId: account.tenantId,
    accountId: account.accountId,
    expectedStateVersion: account.stateVersion,
  };
}

export class GmailConnector implements OAuthCommunicationConnector {
  public readonly connectorKind = 'communication' as const;

  public constructor(
    private readonly dependencies: GmailConnectorDependencies,
  ) {}

  public descriptor() {
    return gmailConnectorDescriptor();
  }

  public authorizationStrategy() {
    return {
      strategy: 'oauth' as const,
      audience: GMAIL_AUTHORIZATION_AUDIENCE,
      scopes: [...GMAIL_OAUTH_SCOPES],
    };
  }

  public beginAuthorization(input: AuthorizationInput) {
    const now = this.dependencies.now?.() ?? new Date().toISOString();
    const ttl = this.dependencies.authorizationTtlSeconds ?? 600;
    return Promise.resolve(
      beginGmailAuthorization({
        request: input,
        authorizationEndpoint:
          this.dependencies.authorizationEndpoint ??
          DEFAULT_AUTHORIZATION_ENDPOINT,
        clientId: this.dependencies.oauthClientId,
        expiresAt: new Date(Date.parse(now) + ttl * 1_000).toISOString(),
      }),
    );
  }

  public async completeAuthorization(input: AuthorizationCallback) {
    const result = await this.dependencies.oauth.completeAuthorization(input);
    if (
      result.account.tenantId !== input.tenantId ||
      result.account.ownerUserId !== input.userId ||
      result.account.provider !== 'google' ||
      result.account.channel !== 'email' ||
      result.account.snapshot.connectorId !== GMAIL_CONNECTOR_ID ||
      result.account.snapshot.descriptorVersion !== GMAIL_DESCRIPTOR_VERSION ||
      result.authorizationAudience !== GMAIL_AUTHORIZATION_AUDIENCE ||
      result.grantedScopes.length !== GMAIL_OAUTH_SCOPES.length ||
      !GMAIL_OAUTH_SCOPES.every((scope) => result.grantedScopes.includes(scope))
    ) {
      throw new Error('GMAIL_OAUTH_ACCOUNT_BINDING_MISMATCH');
    }
    return result.account;
  }

  public validateConnection(account: ConnectorAccountRef) {
    return this.dependencies.history.validateConnection(account);
  }

  public normalizeInboundEvent(
    event: Parameters<
      NonNullable<OAuthCommunicationConnector['normalizeInboundEvent']>
    >[0],
  ) {
    return {
      schemaVersion: '1' as const,
      verifiedEvent: event,
      providerMessageId: event.providerEventId,
      sourceTimestamp: event.verifiedAt,
      canonicalPayloadHash: event.rawPayloadDigest,
    };
  }

  public async poll(
    account: ConnectorAccountRef,
    request: PollRequest,
  ): Promise<SyncPage> {
    const cursor = this.dependencies.cursorCodec.decodeHistoryCursor(request);
    const startHistoryId = cursor.historyId;
    const snapshot = this.dependencies.history.snapshotForAccount(account);
    if (
      snapshot.accountId !== account.accountId ||
      snapshot.connectorId !== GMAIL_CONNECTOR_ID ||
      snapshot.descriptorVersion !== GMAIL_DESCRIPTOR_VERSION
    ) {
      throw new Error('GMAIL_ACCOUNT_SNAPSHOT_MISMATCH');
    }
    const envelopes: SyncPage['envelopes'][number][] = [];
    const seen = new Set<string>();
    let pageToken = cursor.pageToken;
    let pages = 0;
    let latestHistoryId = cursor.latestHistoryId ?? startHistoryId;
    let providerResponseHash: string | undefined;

    do {
      const remaining = request.maxItems - envelopes.length;
      if (remaining <= 0 || pages >= request.maxPages) {
        break;
      }
      let page;
      try {
        page = await this.dependencies.history.listHistory({
          account,
          startHistoryId,
          ...(pageToken === undefined ? {} : { pageToken }),
          maxResults: remaining,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === 'GMAIL_HISTORY_ID_TOO_OLD' ||
            error.message === '404')
        ) {
          throw new GmailHistoryResetRequiredError();
        }
        throw error;
      }
      pages += 1;
      latestHistoryId = page.historyId;
      providerResponseHash = page.providerResponseHash;
      for (const history of page.history) {
        for (const added of history.messagesAdded ?? []) {
          if (
            seen.has(added.message.id) ||
            envelopes.length >= request.maxItems
          ) {
            continue;
          }
          seen.add(added.message.id);
          const message = await this.dependencies.history.getMessage(
            account,
            added.message.id,
          );
          if (message.id !== added.message.id) {
            throw new Error('GMAIL_HISTORY_MESSAGE_ID_MISMATCH');
          }
          if (message.threadId !== added.message.threadId) {
            throw new Error('GMAIL_HISTORY_MESSAGE_THREAD_MISMATCH');
          }
          envelopes.push(
            toCanonicalEnvelope({
              account,
              connectorSnapshot:
                request.checkpoint.adapterVersion === GMAIL_DESCRIPTOR_VERSION
                  ? snapshot
                  : (() => {
                      throw new Error('GMAIL_ADAPTER_VERSION_MISMATCH');
                    })(),
              message,
            }),
          );
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);

    if (providerResponseHash === undefined) {
      throw new Error('GMAIL_HISTORY_PAGE_REQUIRED');
    }
    return {
      envelopes,
      nextEncryptedCursor: this.dependencies.cursorCodec.encodeHistoryCursor({
        historyId: pageToken === undefined ? latestHistoryId : startHistoryId,
        ...(pageToken === undefined ? {} : { pageToken, latestHistoryId }),
      }),
      sourceWatermark: latestHistoryId,
      complete: pageToken === undefined,
      providerResponseHash,
    };
  }

  public async fetchMessage(
    account: ConnectorAccount,
    ref: ProviderMessageRef,
  ) {
    const message = await this.dependencies.history.getMessage(
      accountRef(account),
      ref.providerMessageId,
    );
    if (message.id !== ref.providerMessageId) {
      throw new Error('GMAIL_MESSAGE_ID_MISMATCH');
    }
    if (
      ref.providerThreadId !== undefined &&
      ref.providerThreadId !== message.threadId
    ) {
      throw new Error('GMAIL_MESSAGE_THREAD_MISMATCH');
    }
    const envelope = toCanonicalEnvelope({
      account: accountRef(account),
      connectorSnapshot: account.snapshot,
      message,
    });
    return ref.providerThreadId === undefined
      ? {
          ...envelope,
          providerMessageRef: {
            providerMessageId: envelope.providerMessageRef.providerMessageId,
          },
        }
      : envelope;
  }

  public async fetchThread(account: ConnectorAccount, ref: ProviderThreadRef) {
    const thread = await this.dependencies.history.getThread(
      accountRef(account),
      ref.providerThreadId,
    );
    if (thread.id !== ref.providerThreadId) {
      throw new Error('GMAIL_THREAD_ID_MISMATCH');
    }
    return thread.messages.map((message) => {
      if (message.threadId !== thread.id) {
        throw new Error('GMAIL_THREAD_MESSAGE_BINDING_MISMATCH');
      }
      return toCanonicalEnvelope({
        account: accountRef(account),
        connectorSnapshot: account.snapshot,
        message,
      });
    });
  }

  public send(
    account: ConnectorAccountRef,
    artifact: Parameters<typeof sendGmailEffect>[2],
  ) {
    return sendGmailEffect(this.dependencies.send, account, artifact);
  }

  public reconcileSend(
    account: ConnectorAccountRef,
    request: Parameters<typeof reconcileGmailEffect>[2],
  ) {
    return reconcileGmailEffect(this.dependencies.send, account, request);
  }
}
