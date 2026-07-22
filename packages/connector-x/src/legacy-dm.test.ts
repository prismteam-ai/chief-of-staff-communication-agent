import { pollRequestSchema } from '@chief/contracts/connectors';
import { describe, expect, it } from 'vitest';

import { xLegacyDmFixtures } from './connector.js';
import {
  buildLegacyDmLookupRequest,
  buildLegacyDmSendArtifact,
  normalizeLegacyDmPollPage,
  parseLegacyDmCreateResponse,
  parseLegacyDmLookupResponse,
  XBudgetDeniedError,
} from './legacy-dm.js';
import {
  fixtureBytes,
  LEGACY_DM_LOOKUP_FIXTURE_JSON,
  parseFixtureJson,
} from './provider-fixtures.js';

const parsedLookup = parseLegacyDmLookupResponse(
  parseFixtureJson(LEGACY_DM_LOOKUP_FIXTURE_JSON),
);

describe('X legacy DM provider shapes', () => {
  it('preserves the recorded fixture bytes exactly', () => {
    expect(
      new TextDecoder().decode(fixtureBytes(LEGACY_DM_LOOKUP_FIXTURE_JSON)),
    ).toBe(LEGACY_DM_LOOKUP_FIXTURE_JSON);
    expect(parsedLookup.meta).toEqual({
      result_count: 4,
      next_token: 'fixture-page-2',
    });
  });

  it('builds bounded lookup request shapes without mixing cursor namespaces', () => {
    expect(
      buildLegacyDmLookupRequest({
        cursor: 'xlegacy:cursor-a',
        maxResults: 50,
        participantId: '2244994945',
      }),
    ).toMatchObject({
      method: 'GET',
      path: '/2/dm_conversations/with/2244994945/dm_events',
      query: { max_results: '50', pagination_token: 'cursor-a' },
    });
    expect(() =>
      buildLegacyDmLookupRequest({
        cursor: 'xchat:cursor-a',
        maxResults: 50,
      }),
    ).toThrow('X_LEGACY_CURSOR_NAMESPACE_MISMATCH');
    expect(() =>
      buildLegacyDmLookupRequest({
        maxResults: 50,
        conversationId: 'conversation-a',
        participantId: 'participant-a',
      }),
    ).toThrow('X_LOOKUP_TARGET_AMBIGUOUS');
  });

  it('parses the provider manage response without calling X', () => {
    expect(
      parseLegacyDmCreateResponse({
        data: {
          dm_conversation_id: 'conversation-a',
          dm_event_id: 'event-a',
        },
      }),
    ).toEqual({
      data: {
        dm_conversation_id: 'conversation-a',
        dm_event_id: 'event-a',
      },
    });
  });

  it('deduplicates and enforces the 30-day recent-history limitation', () => {
    const page = normalizeLegacyDmPollPage({
      request: xLegacyDmFixtures.pollRequest,
      response: parsedLookup,
      budget: {
        remainingRequests: 1,
        remainingResources: 100,
        remainingCostUsd: 1,
        readResourceUnitCostUsd: 0.01,
      },
      now: '2026-07-17T12:00:00.000Z',
    });
    expect(page.events.map(({ id }) => id)).toEqual([
      '1890000000000000002',
      '1900000000000000001',
    ]);
    expect(page).toMatchObject({
      nextCursor: 'xlegacy:fixture-page-2',
      historyHorizonDays: 30,
      duplicateCount: 1,
      excludedBeforeHorizon: 1,
    });
  });

  it('denies rate and spend budgets before fixture processing', () => {
    const cases = [
      {
        remainingRequests: 0,
        remainingResources: 100,
        remainingCostUsd: 1,
        readResourceUnitCostUsd: 0.01,
        code: 'X_RATE_BUDGET_DENIED',
      },
      {
        remainingRequests: 1,
        remainingResources: 100,
        remainingCostUsd: 0.001,
        readResourceUnitCostUsd: 0.01,
        code: 'X_COST_BUDGET_DENIED',
      },
    ] as const;
    for (const testCase of cases) {
      try {
        normalizeLegacyDmPollPage({
          request: xLegacyDmFixtures.pollRequest,
          response: parsedLookup,
          budget: testCase,
          now: '2026-07-17T12:00:00.000Z',
        });
        throw new Error('expected budget denial');
      } catch (error) {
        expect(error).toBeInstanceOf(XBudgetDeniedError);
        expect((error as XBudgetDeniedError).reasonCode).toBe(testCase.code);
      }
    }
  });

  it('creates only an effect-disabled request artifact after correlation binding', () => {
    const artifact = buildLegacyDmSendArtifact(xLegacyDmFixtures.artifact, {
      text: 'Approved fixture text',
      participantId: '2244994945',
    });
    expect(artifact.execution).toBe('effect_disabled');
    expect(artifact.preDispatchBinding).toMatchObject({
      operationId: xLegacyDmFixtures.artifact.operationId,
      attemptId: xLegacyDmFixtures.artifact.attemptId,
      clientCorrelation: { kind: 'client_reference' },
    });
    expect(artifact.request).toEqual({
      method: 'POST',
      path: '/2/dm_conversations/with/2244994945/messages',
      body: { text: 'Approved fixture text' },
    });
  });

  it('rejects account and connector ambiguity in send artifacts and checkpoints', () => {
    expect(() =>
      buildLegacyDmSendArtifact(
        {
          ...xLegacyDmFixtures.artifact,
          connectorSnapshot: {
            ...xLegacyDmFixtures.artifact.connectorSnapshot,
            connectorId: 'xchat_encrypted',
          },
        },
        { text: 'blocked', participantId: '2244994945' },
      ),
    ).toThrow('X_SEND_ARTIFACT_BINDING_MISMATCH');
    const mixedCursorRequest = pollRequestSchema.parse({
      ...xLegacyDmFixtures.pollRequest,
      checkpoint: {
        ...xLegacyDmFixtures.pollRequest.checkpoint,
        encryptedCursor: 'xchat:cursor-a',
      },
    });
    expect(() =>
      normalizeLegacyDmPollPage({
        request: mixedCursorRequest,
        response: parsedLookup,
        budget: {
          remainingRequests: 1,
          remainingResources: 100,
          remainingCostUsd: 1,
          readResourceUnitCostUsd: 0.01,
        },
        now: '2026-07-17T12:00:00.000Z',
      }),
    ).toThrow('X_LEGACY_CURSOR_NAMESPACE_MISMATCH');
  });
});
