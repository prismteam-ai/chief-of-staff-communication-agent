import type { gmail_v1 } from 'googleapis';
import {
  createGmailClientForAccount,
  GmailConnector,
  type GmailSendConfirmation,
} from '@chief-of-staff/connectors/gmail';
import type { Connector } from '@chief-of-staff/connectors';

/**
 * Wires the real Gmail send path for the API Lambda (Task 6, design.md §7): a `GmailConnector`
 * constructed with `sendRawMessage`/`resolveFromAddress` backed by the same
 * `createGmailClientForAccount` (Secrets Manager-backed OAuth, `gmail.send` scope) the ingest
 * poller/processor already use — one shared implementation (`packages/connectors/src/gmail/gmail-client.ts`),
 * no duplicated OAuth handling.
 *
 * `resolveFromAddress` calls `users.getProfile` rather than trusting a passed-in address: the
 * account's own mailbox address is provider-authoritative, not something the caller should assert.
 */

let cachedGmailClientPromises: Map<string, Promise<gmail_v1.Gmail>> | undefined;
function gmailClientCache(): Map<string, Promise<gmail_v1.Gmail>> {
  cachedGmailClientPromises ??= new Map();
  return cachedGmailClientPromises;
}

function gmailClientFor(accountId: string): Promise<gmail_v1.Gmail> {
  const cache = gmailClientCache();
  let client = cache.get(accountId);
  if (!client) {
    client = createGmailClientForAccount(accountId);
    cache.set(accountId, client);
  }
  return client;
}

export function createRealGmailConnector(): Connector {
  return new GmailConnector({
    async resolveFromAddress(accountId) {
      const gmail = await gmailClientFor(accountId);
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const address = profile.data.emailAddress;
      if (!address) {
        throw new Error(
          `Gmail users.getProfile for account "${accountId}" returned no emailAddress`,
        );
      }
      return address;
    },

    async sendRawMessage(accountId, rawBase64Url, threadId): Promise<GmailSendConfirmation> {
      const gmail = await gmailClientFor(accountId);
      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: rawBase64Url, threadId },
      });
      if (!response.data.id) {
        throw new Error(
          `Gmail users.messages.send for account "${accountId}" returned no message id`,
        );
      }
      return { id: response.data.id };
    },
  });
}
