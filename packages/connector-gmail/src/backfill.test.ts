import { describe, expect, it } from 'vitest';

import { backfillGmailMessages } from './backfill.js';
import {
  createGmailContractFixtures,
  createGmailFixtureDependencies,
  GMAIL_PROVIDER_MESSAGE_FIXTURE,
} from './provider-fixtures.js';

describe('Gmail bounded backfill', () => {
  it('fences current history before fetching full provider messages', async () => {
    const fixtures = createGmailContractFixtures();
    const dependencies = createGmailFixtureDependencies(fixtures);
    const result = await backfillGmailMessages(dependencies.history, {
      account: fixtures.accountRef,
      connectorSnapshot: fixtures.snapshot,
      maxItems: 100,
      maxPages: 2,
    });
    expect(result).toMatchObject({
      fencedHistoryId: '100',
      sourceWatermark: '100',
      complete: true,
      envelopes: [
        {
          providerMessageRef: {
            providerMessageId: 'provider-message-a',
            providerThreadId: 'provider-thread-a',
          },
        },
      ],
    });
  });

  it('retains the original fence across bounded continuation pages', async () => {
    const fixtures = createGmailContractFixtures();
    const dependencies = createGmailFixtureDependencies(fixtures);
    dependencies.history.listMessagesForBackfill = () =>
      Promise.resolve({
        messages: [],
        nextPageToken: 'page-2',
        providerResponseHash: 'f'.repeat(64),
      });
    const result = await backfillGmailMessages(dependencies.history, {
      account: fixtures.accountRef,
      connectorSnapshot: fixtures.snapshot,
      maxItems: 1,
      maxPages: 1,
      fencedHistoryId: '100',
      pageToken: 'page-1',
    });
    expect(result).toMatchObject({
      fencedHistoryId: '100',
      nextPageToken: 'page-2',
      complete: false,
    });
  });

  it('rejects a same-thread message ID substitution', async () => {
    const fixtures = createGmailContractFixtures();
    const dependencies = createGmailFixtureDependencies(fixtures);
    dependencies.history.getMessage = () =>
      Promise.resolve({
        ...GMAIL_PROVIDER_MESSAGE_FIXTURE,
        id: 'provider-message-substituted',
      });
    await expect(
      backfillGmailMessages(dependencies.history, {
        account: fixtures.accountRef,
        connectorSnapshot: fixtures.snapshot,
        maxItems: 1,
        maxPages: 1,
      }),
    ).rejects.toThrow('GMAIL_BACKFILL_MESSAGE_ID_MISMATCH');
  });
});
