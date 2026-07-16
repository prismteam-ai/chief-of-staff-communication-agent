import { describe, expect, it } from 'vitest';
import { NormalizedMessageSchema } from '@chief-of-staff/shared';
import type { Connector, ConnectorEvent } from './types.js';

/**
 * Reusable vitest suite factory: any connector implementation must pass this suite. Task 3+
 * per-channel connector test files call `defineConnectorContractTests('gmail', () => new
 * GmailConnector(...))` and get the shared assertions for free instead of re-deriving them.
 *
 * Checks (brief constraint 4/6):
 *   - `ingest` emits messages that validate against `NormalizedMessageSchema`.
 *   - `externalId` is stable across repeated `ingest` calls with the same event (dedupe depends
 *     on this).
 *   - `ingest` honors the `accountId` passed in the event — every emitted message carries it.
 *
 * `makeEvent` lets a connector under test override the default `ConnectorEvent` fixture (e.g. a
 * real connector may need a shaped `raw` payload); the default is a minimal, channel-agnostic
 * fixture suitable for the trivial in-memory case.
 */
export function defineConnectorContractTests(
  label: string,
  makeConnector: () => Connector,
  makeEvent: () => ConnectorEvent = () => ({ accountId: 'acct_contract-test', raw: {} }),
): void {
  describe(`connector contract: ${label}`, () => {
    it('emits messages that validate as NormalizedMessage', async () => {
      const connector = makeConnector();
      const messages = await connector.ingest(makeEvent());

      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) {
        const result = NormalizedMessageSchema.safeParse(message);
        expect(result.success).toBe(true);
      }
    });

    it('emits a stable externalId across repeated ingest calls for the same event', async () => {
      const connector = makeConnector();
      const event = makeEvent();

      const first = await connector.ingest(event);
      const second = await connector.ingest(event);

      expect(first.length).toBe(second.length);
      const firstIds = first.map((m) => m.externalId).sort();
      const secondIds = second.map((m) => m.externalId).sort();
      expect(secondIds).toEqual(firstIds);
    });

    it('honors the accountId from the event on every emitted message', async () => {
      const connector = makeConnector();
      const event = makeEvent();

      const messages = await connector.ingest(event);

      for (const message of messages) {
        expect(message.accountId).toBe(event.accountId);
      }
    });

    it('identity resolves a participant id to the given account', async () => {
      const connector = makeConnector();
      const event = makeEvent();

      const resolved = await connector.identity('someone@example.com', event.accountId);

      expect(resolved.accountId).toBe(event.accountId);
    });
  });
}
