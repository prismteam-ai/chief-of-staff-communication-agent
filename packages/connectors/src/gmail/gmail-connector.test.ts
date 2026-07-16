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

  it('always exposes send — Gmail is a Live/sendable channel (channel-access-tiers.md)', () => {
    const connector: Connector = new GmailConnector();
    expect(connector.send).toBeTypeOf('function');
  });

  describe('send', () => {
    const outbound = {
      accountId: ACCOUNT_ID,
      threadKey: '18f2b7e0a1c2d301',
      inReplyToExternalId: '18f2b8f1b2d3e402',
      inReplyToMessageId: '<CAF+contract-thread-002@mail.gmail.com>',
      subject: 'Re: Meridian rollout contract — two clauses to discuss',
      to: ['daniel.osei@meridian-partners.io'],
      body: 'Sounds good — 2pm tomorrow works.\n\nAlex',
    };

    it('calls sendRawMessage with the account id, the built raw MIME, and the thread id', async () => {
      const calls: { accountId: string; raw: string; threadId: string }[] = [];
      const connector = new GmailConnector({
        sendRawMessage: async (accountId, raw, threadId) => {
          calls.push({ accountId, raw, threadId });
          return { id: 'sent-message-1' };
        },
        resolveFromAddress: async () => 'demoalex775@gmail.com',
      });

      await connector.send?.(outbound);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.accountId).toBe(ACCOUNT_ID);
      expect(calls[0]?.threadId).toBe('18f2b7e0a1c2d301');
      expect(calls[0]?.raw).toEqual(expect.any(String));
    });

    it('returns the providerMessageId from the send confirmation', async () => {
      const connector = new GmailConnector({
        sendRawMessage: async () => ({ id: 'sent-message-42' }),
        resolveFromAddress: async () => 'demoalex775@gmail.com',
      });

      const result = await connector.send?.(outbound);

      expect(result).toEqual({ providerMessageId: 'sent-message-42' });
    });

    it('resolves the From address for the connected account before building the MIME', async () => {
      const fromCalls: string[] = [];
      const connector = new GmailConnector({
        sendRawMessage: async () => ({ id: 'sent-1' }),
        resolveFromAddress: async (accountId) => {
          fromCalls.push(accountId);
          return 'demoalex775@gmail.com';
        },
      });

      await connector.send?.(outbound);

      expect(fromCalls).toEqual([ACCOUNT_ID]);
    });

    it('throws if constructed without send dependencies and send is called', async () => {
      const connector = new GmailConnector();
      await expect(connector.send?.(outbound)).rejects.toThrow();
    });
  });
});
