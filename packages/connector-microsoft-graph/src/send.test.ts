import { describe, expect, it } from 'vitest';

import { createMicrosoftGraphContractFixtures } from './provider-fixtures.js';
import {
  dispatchGraphPreboundDraft,
  reconcileGraphPreboundDraft,
  type GraphDraftTransport,
} from './send.js';

describe('Microsoft Graph draft-then-send reconciliation', () => {
  it('treats Graph 202 as accepted, never delivered', async () => {
    const fixture = createMicrosoftGraphContractFixtures();
    let immutablePreference = false;
    const result = await dispatchGraphPreboundDraft(fixture.artifact, {
      sendPreboundDraft: (input) => {
        immutablePreference = input.preferImmutableId;
        return Promise.resolve({
          status: 202,
          requestId: 'request-a',
          observedAt: '2026-07-17T13:00:00.000Z',
        });
      },
      findSentItem: () => Promise.resolve(undefined),
    });
    expect(immutablePreference).toBe(true);
    expect(result.outcome).toBe('accepted');
    expect(result).not.toHaveProperty('delivered');
  });

  it('fails closed for bare sendMail without prebound immutable draft identity', async () => {
    const fixture = createMicrosoftGraphContractFixtures();
    await expect(
      dispatchGraphPreboundDraft(
        {
          ...fixture.artifact,
          clientCorrelation: {
            kind: 'client_reference',
            value: 'bare-sendmail-reference',
          },
        },
        neverCalledTransport,
      ),
    ).rejects.toThrow('GRAPH_BARE_SENDMAIL_FORBIDDEN');
  });

  it('keeps inconclusive bounded Sent Items lookup acceptance_unknown', async () => {
    const fixture = createMicrosoftGraphContractFixtures();
    const result = await reconcileGraphPreboundDraft(fixture.reconcileRequest, {
      sendPreboundDraft: () => Promise.reject(new Error('not used')),
      findSentItem: ({ maxQueries }) => {
        expect(maxQueries).toBe(2);
        return Promise.resolve(undefined);
      },
    });
    expect(result).toMatchObject({
      outcome: 'acceptance_unknown',
      reasonCode: 'graph_sent_item_not_proven_within_bound',
    });
  });
});

const neverCalledTransport: GraphDraftTransport = {
  sendPreboundDraft: () => Promise.reject(new Error('unexpected dispatch')),
  findSentItem: () => Promise.reject(new Error('unexpected reconciliation')),
};
