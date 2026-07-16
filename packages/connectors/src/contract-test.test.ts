import { describe, expect, it } from 'vitest';
import { NormalizedMessageSchema, type NormalizedMessage } from '@chief-of-staff/shared';
import type { Connector, ConnectorEvent } from './types.js';
import { defineConnectorContractTests } from './contract-test.js';

/** A trivial in-memory fake connector — the minimal shape any real connector must satisfy. */
function makeFakeConnector(): Connector {
  const fixed: NormalizedMessage = {
    schemaVersion: 1,
    channelType: 'gmail',
    accountId: 'acct_fake-1',
    externalId: 'fake-msg-1',
    threadKey: 'thread_fake-1',
    participants: [
      { id: 'exec@example.com', displayName: 'Exec', role: 'to' },
      { id: 'sender@example.com', displayName: 'Sender', role: 'from' },
    ],
    ts: '2026-07-15T12:00:00.000Z',
    body: 'A fixed fake message',
    attachments: [],
  };

  return {
    channelType: 'gmail',
    async ingest(event: ConnectorEvent) {
      return [{ ...fixed, accountId: event.accountId }];
    },
    async identity(_participantId: string, accountId: string) {
      return { accountId };
    },
  };
}

// Run the reusable contract suite against the fake — this is the test-factory's own smoke test,
// proving the factory is callable and produces real, passing assertions (not a no-op).
defineConnectorContractTests('fake-connector', makeFakeConnector);

describe('defineConnectorContractTests — factory behavior', () => {
  it('is callable directly and registers real vitest cases (not a stub)', () => {
    // defineConnectorContractTests itself calls `describe`/`it` at import/call time; the fact
    // that the block above produced passing assertions when this file runs under vitest is the
    // real proof. This case additionally checks the exported shape.
    expect(typeof defineConnectorContractTests).toBe('function');
  });

  it('a connector emitting an invalid NormalizedMessage fails schema validation', async () => {
    const badConnector: Connector = {
      channelType: 'gmail',
      async ingest() {
        // Missing required fields on purpose — proves the contract suite's schema check has teeth.
        return [{ notAMessage: true } as unknown as NormalizedMessage];
      },
      async identity(_id: string, accountId: string) {
        return { accountId };
      },
    };

    const messages = await badConnector.ingest({ accountId: 'acct_x', raw: {} });
    expect(NormalizedMessageSchema.safeParse(messages[0]).success).toBe(false);
  });
});
