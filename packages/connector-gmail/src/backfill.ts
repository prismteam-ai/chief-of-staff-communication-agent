import type {
  CanonicalEnvelope,
  ConnectorAccountRef,
  ConnectorSnapshot,
} from '@chief/contracts/connectors';

import { toCanonicalEnvelope } from './normalization.js';
import type { GmailHistoryClient } from './types.js';

export interface GmailBackfillRequest {
  readonly account: ConnectorAccountRef;
  readonly connectorSnapshot: ConnectorSnapshot;
  readonly maxItems: number;
  readonly maxPages: number;
  readonly pageToken?: string;
  readonly fencedHistoryId?: string;
}

export interface GmailBackfillResult {
  readonly envelopes: readonly CanonicalEnvelope[];
  readonly fencedHistoryId: string;
  readonly sourceWatermark: string;
  readonly nextPageToken?: string;
  readonly complete: boolean;
  readonly providerResponseHash: string;
}

export async function backfillGmailMessages(
  client: GmailHistoryClient,
  request: GmailBackfillRequest,
): Promise<GmailBackfillResult> {
  if (
    request.maxItems <= 0 ||
    request.maxItems > 1_000 ||
    request.maxPages <= 0 ||
    request.maxPages > 10
  ) {
    throw new Error('GMAIL_BACKFILL_BUDGET_REJECTED');
  }
  if (
    request.connectorSnapshot.accountId !== request.account.accountId ||
    client.snapshotForAccount(request.account).capabilitySnapshotHash !==
      request.connectorSnapshot.capabilitySnapshotHash
  ) {
    throw new Error('GMAIL_BACKFILL_ACCOUNT_SNAPSHOT_MISMATCH');
  }
  const fence =
    request.fencedHistoryId === undefined
      ? await client.getCurrentHistoryId(request.account)
      : {
          historyId: request.fencedHistoryId,
          providerResponseHash: undefined,
        };
  const envelopes: CanonicalEnvelope[] = [];
  const seen = new Set<string>();
  let pageToken = request.pageToken;
  let pages = 0;
  let providerResponseHash = fence.providerResponseHash;

  do {
    const remaining = request.maxItems - envelopes.length;
    if (remaining <= 0 || pages >= request.maxPages) {
      break;
    }
    const page = await client.listMessagesForBackfill({
      account: request.account,
      ...(pageToken === undefined ? {} : { pageToken }),
      maxResults: remaining,
    });
    pages += 1;
    providerResponseHash = page.providerResponseHash;
    for (const ref of page.messages) {
      if (seen.has(ref.id) || envelopes.length >= request.maxItems) {
        continue;
      }
      seen.add(ref.id);
      const message = await client.getMessage(request.account, ref.id);
      if (message.id !== ref.id) {
        throw new Error('GMAIL_BACKFILL_MESSAGE_ID_MISMATCH');
      }
      if (message.threadId !== ref.threadId) {
        throw new Error('GMAIL_BACKFILL_MESSAGE_THREAD_MISMATCH');
      }
      envelopes.push(
        toCanonicalEnvelope({
          account: request.account,
          connectorSnapshot: request.connectorSnapshot,
          message,
        }),
      );
    }
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);

  if (providerResponseHash === undefined) {
    throw new Error('GMAIL_BACKFILL_PAGE_REQUIRED');
  }
  return {
    envelopes,
    fencedHistoryId: fence.historyId,
    sourceWatermark: fence.historyId,
    ...(pageToken === undefined ? {} : { nextPageToken: pageToken }),
    complete: pageToken === undefined,
    providerResponseHash,
  };
}
