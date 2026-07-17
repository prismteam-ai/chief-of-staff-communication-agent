import { describe, expect, it } from 'vitest';
import type { Connector } from '../types.js';
import { defineConnectorContractTests } from '../contract-test.js';
import { WhatsAppConnector } from './whatsapp-connector.js';

const ACCOUNT_ID = 'acct-whatsapp-sandbox';

function twilioPayload(): Record<string, string> {
  return {
    MessageSid: 'SM1234567890abcdef1234567890abcdef',
    From: 'whatsapp:+15551234567',
    To: 'whatsapp:+14155238886',
    Body: 'Can we push the Thursday sync to 3pm?',
    NumMedia: '0',
  };
}

// Runs the reusable contract suite (packages/connectors/src/contract-test.ts) against the real
// WhatsApp connector with a realistic Twilio inbound payload — "MUST pass the ./testing
// contract-test factory" (brief constraint 2), same posture as the Gmail connector test.
defineConnectorContractTests(
  'whatsapp',
  () => new WhatsAppConnector(),
  () => ({ accountId: ACCOUNT_ID, raw: twilioPayload() }),
);

describe('WhatsAppConnector', () => {
  it('normalizes a Twilio inbound webhook payload into exactly one NormalizedMessage', async () => {
    const connector = new WhatsAppConnector();

    const messages = await connector.ingest({ accountId: ACCOUNT_ID, raw: twilioPayload() });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.channelType).toBe('whatsapp');
    expect(messages[0]?.externalId).toBe('SM1234567890abcdef1234567890abcdef');
  });

  it('rejects a malformed raw payload instead of silently returning nothing', async () => {
    const connector = new WhatsAppConnector();

    await expect(connector.ingest({ accountId: ACCOUNT_ID, raw: null })).rejects.toThrow();
  });

  it('always exposes send — WhatsApp is a Sandbox/sendable channel (channel-access-tiers.md)', () => {
    const connector: Connector = new WhatsAppConnector();
    expect(connector.send).toBeTypeOf('function');
  });

  describe('send', () => {
    const outbound = {
      accountId: ACCOUNT_ID,
      threadKey: '+15551234567',
      to: ['+15551234567'],
      body: 'Yes, 3pm works for me.',
    };

    it('calls sendMessage with the recipient and body', async () => {
      const calls: { to: string; body: string }[] = [];
      const connector = new WhatsAppConnector({
        sendMessage: async (to, body) => {
          calls.push({ to, body });
          return { sid: 'SM_sent_1', status: 'queued' };
        },
      });

      await connector.send?.(outbound);

      expect(calls).toEqual([{ to: '+15551234567', body: 'Yes, 3pm works for me.' }]);
    });

    it('returns the providerMessageId (Twilio SID) from the send confirmation', async () => {
      const connector = new WhatsAppConnector({
        sendMessage: async () => ({ sid: 'SM_sent_42', status: 'queued' }),
      });

      const result = await connector.send?.(outbound);

      expect(result).toEqual({ providerMessageId: 'SM_sent_42' });
    });

    it('throws if constructed without send dependencies and send is called', async () => {
      const connector = new WhatsAppConnector();
      await expect(connector.send?.(outbound)).rejects.toThrow();
    });

    it('throws if called with no recipients', async () => {
      const connector = new WhatsAppConnector({
        sendMessage: async () => ({ sid: 'SM_sent_1', status: 'queued' }),
      });

      await expect(connector.send?.({ ...outbound, to: [] })).rejects.toThrow();
    });
  });

  describe('identity', () => {
    it('maps every participant to the single demo sandbox account', async () => {
      const connector = new WhatsAppConnector();

      const resolved = await connector.identity('+15551234567', ACCOUNT_ID);

      expect(resolved).toEqual({ accountId: ACCOUNT_ID });
    });
  });
});
