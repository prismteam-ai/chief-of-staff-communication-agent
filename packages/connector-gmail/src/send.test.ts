import { describe, expect, it } from 'vitest';

import {
  createGmailContractFixtures,
  createGmailFixtureDependencies,
} from './provider-fixtures.js';
import { reconcileGmailEffect, sendGmailEffect } from './send.js';

describe('Gmail send and reconciliation facts', () => {
  it('returns atomic Gmail message/thread correlation after acceptance', async () => {
    const fixtures = createGmailContractFixtures();
    const dependencies = createGmailFixtureDependencies(fixtures);
    await expect(
      sendGmailEffect(
        dependencies.send,
        fixtures.accountRef,
        fixtures.artifact,
      ),
    ).resolves.toMatchObject({
      outcome: 'accepted',
      providerCorrelation:
        'gmail:message:gmail-sent-message-a:thread:provider-thread-a',
    });
    expect(dependencies.calls.send).toBe(1);
  });

  it('keeps inconclusive bounded Sent-mail reconciliation unknown', async () => {
    const fixtures = createGmailContractFixtures();
    const dependencies = createGmailFixtureDependencies(fixtures);
    dependencies.send.findSentByClientCorrelation = () => Promise.resolve([]);
    await expect(
      reconcileGmailEffect(
        dependencies.send,
        fixtures.accountRef,
        fixtures.reconcileRequest,
      ),
    ).resolves.toMatchObject({
      outcome: 'acceptance_unknown',
      reasonCode: 'gmail_sent_match_not_found_within_bound',
    });
  });

  it('refuses dispatch without a prebound RFC 5322 client correlation', async () => {
    const fixtures = createGmailContractFixtures();
    const dependencies = createGmailFixtureDependencies(fixtures);
    await expect(
      sendGmailEffect(dependencies.send, fixtures.accountRef, {
        ...fixtures.artifact,
        clientCorrelation: { kind: 'client_reference', value: 'operation-a' },
      }),
    ).rejects.toThrow('GMAIL_CLIENT_CORRELATION_NOT_PREBOUND');
    expect(dependencies.calls.send).toBe(0);
  });
});
