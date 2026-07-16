import { describe, expect, it } from 'vitest';
import type { Connector } from '../types.js';
import { defineConnectorContractTests } from '../contract-test.js';
import { GmailConnector } from './gmail-connector.js';
import type { GmailMessage } from './normalize.js';
import simpleMessage from './fixtures/simple-message.json' with { type: 'json' };
import threadOriginal from './fixtures/thread-original.json' with { type: 'json' };
import threadReply from './fixtures/thread-reply.json' with { type: 'json' };
import messageWithAttachment from './fixtures/message-with-attachment.json' with { type: 'json' };

const ACCOUNT_ID = 'acct_demo-alex-gmail';

// Runs the reusable contract suite (packages/connectors/src/contract-test.ts) against the real
// Gmail connector with a realistic multi-message raw payload — this is what "MUST pass the
// ./testing contract-test factory" (brief constraint 2) means in practice.
defineConnectorContractTests(
  'gmail',
  () => new GmailConnector(),
  () => ({
    accountId: ACCOUNT_ID,
    raw: { messages: [simpleMessage as GmailMessage] },
  }),
);

describe('GmailConnector', () => {
  it('normalizes every message in a multi-message ingest payload', async () => {
    const connector = new GmailConnector();

    const messages = await connector.ingest({
      accountId: ACCOUNT_ID,
      raw: {
        messages: [
          simpleMessage,
          threadOriginal,
          threadReply,
          messageWithAttachment,
        ] as GmailMessage[],
      },
    });

    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.externalId)).toEqual([
      '18f2a1c3d4e5f601',
      '18f2b7e0a1c2d301',
      '18f2b8f1b2d3e402',
      '18f2c4a9e5f60703',
    ]);
  });

  it('preserves the shared threadKey across the original message and its reply', async () => {
    const connector = new GmailConnector();

    const messages = await connector.ingest({
      accountId: ACCOUNT_ID,
      raw: { messages: [threadOriginal, threadReply] as GmailMessage[] },
    });

    const [original, reply] = messages;
    expect(original?.threadKey).toBe(reply?.threadKey);
  });

  it('rejects a malformed raw payload instead of silently returning nothing', async () => {
    const connector = new GmailConnector();

    await expect(
      connector.ingest({ accountId: ACCOUNT_ID, raw: { notMessages: [] } }),
    ).rejects.toThrow();
  });

  it('has no send implementation yet — deferred to Task 6', () => {
    const connector: Connector = new GmailConnector();
    expect(connector.send).toBeUndefined();
  });
});
