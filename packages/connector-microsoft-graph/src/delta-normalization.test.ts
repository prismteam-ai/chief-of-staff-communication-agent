import { describe, expect, it } from 'vitest';

import {
  GraphDeltaRequestError,
  classifyGraphDeltaFailure,
  pollGraphDelta,
  pollGraphDeltaWithResetRecovery,
} from './delta.js';
import { normalizeGraphMessage } from './normalization.js';
import { createMicrosoftGraphContractFixtures } from './provider-fixtures.js';
import { graphDeltaFixture, graphMessageFixture } from './recorded-fixtures.js';

describe('Microsoft Graph delta and normalization', () => {
  it('uses immutable IDs and preserves thread, attachments, and reply headers', () => {
    const fixture = createMicrosoftGraphContractFixtures();
    const normalized = normalizeGraphMessage(graphMessageFixture, {
      account: fixture.accountRef,
      snapshot: fixture.snapshot,
      rawBodyRef: 'fixture://graph/message-a',
    });
    expect(normalized.envelope.providerMessageRef).toEqual({
      providerMessageId: 'provider-message-a',
      providerThreadId: 'provider-thread-a',
    });
    expect(normalized.message.attachments).toHaveLength(1);
    expect(normalized.message.replyHeaders).toEqual({
      inReplyTo: '<previous@example.invalid>',
      references: ['<root@example.invalid>', '<previous@example.invalid>'],
    });
  });

  it('polls a bounded terminal delta page with ImmutableId preference', async () => {
    const fixture = createMicrosoftGraphContractFixtures();
    let immutablePreference = false;
    const page = await pollGraphDelta(
      {
        poll: (input) => {
          immutablePreference = input.preferImmutableId;
          return Promise.resolve({
            response: graphDeltaFixture,
            nextSealedCursor: 'sealed:graph-delta-terminal',
          });
        },
      },
      fixture.pollRequest,
      {
        account: fixture.accountRef,
        snapshot: fixture.snapshot,
        rawBodyRef: 'fixture://graph/delta-a',
      },
    );
    expect(immutablePreference).toBe(true);
    expect(page.complete).toBe(true);
    expect(page.envelopes).toHaveLength(1);
    expect(page.nextEncryptedCursor).toBe('sealed:graph-delta-terminal');
    expect(page.sourceWatermark).not.toContain('$deltatoken');
  });

  it('classifies expired delta tokens as reset/restart, not empty success', () => {
    expect(classifyGraphDeltaFailure(410, 'SyncStateNotFound')).toEqual({
      action: 'restart',
      reason: 'delta_token_expired',
    });
    expect(classifyGraphDeltaFailure(429)).toEqual({
      action: 'retry',
      reason: 'rate_limited',
    });
  });

  it('restarts once from the bounded root delta after an expired token', async () => {
    const fixture = createMicrosoftGraphContractFixtures();
    let restartCount = 0;
    const page = await pollGraphDeltaWithResetRecovery(
      {
        poll: () => Promise.reject(new GraphDeltaRequestError(410)),
        restart: (input) => {
          restartCount += 1;
          expect(input.preferImmutableId).toBe(true);
          expect(input.maxItems).toBe(fixture.pollRequest.maxItems);
          return Promise.resolve({
            response: graphDeltaFixture,
            nextSealedCursor: 'sealed:graph-delta-restarted',
          });
        },
      },
      fixture.pollRequest,
      {
        account: fixture.accountRef,
        snapshot: fixture.snapshot,
        rawBodyRef: 'fixture://graph/delta-restarted',
      },
    );
    expect(restartCount).toBe(1);
    expect(page.nextEncryptedCursor).toBe('sealed:graph-delta-restarted');
  });
});
