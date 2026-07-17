import { describe, expect, it } from 'vitest';

import { deduplicateXActivityEvents, parseXActivityEvent } from './activity.js';
import {
  LEGACY_DM_ACTIVITY_FIXTURE_JSON,
  parseFixtureJson,
  XCHAT_ACTIVITY_FIXTURE_JSON,
} from './provider-fixtures.js';

function eventsFromFixture(exactJson: string): readonly unknown[] {
  const raw = parseFixtureJson(exactJson);
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('events' in raw) ||
    !Array.isArray(raw.events)
  ) {
    throw new Error('fixture event array missing');
  }
  return raw.events;
}

describe('X Activity namespaces', () => {
  it('parses and deduplicates dm.* events only in the legacy namespace', () => {
    const parsed = eventsFromFixture(LEGACY_DM_ACTIVITY_FIXTURE_JSON).map(
      (event) => parseXActivityEvent(event, 'legacy_dm'),
    );
    expect(parsed.every(({ kind }) => kind === 'parsed')).toBe(true);
    const events = parsed.flatMap((result) =>
      result.kind === 'parsed' ? [result.event] : [],
    );
    expect(deduplicateXActivityEvents(events)).toMatchObject({
      duplicateCount: 1,
      events: [{ namespace: 'legacy_dm', eventType: 'dm.received' }],
    });
    expect(
      parseXActivityEvent(
        eventsFromFixture(LEGACY_DM_ACTIVITY_FIXTURE_JSON)[0],
        'xchat_encrypted',
      ),
    ).toEqual({
      kind: 'unsupported',
      fact: 'unknown',
      reason: 'activity_namespace_mismatch',
    });
  });

  it('parses chat.* without claiming plaintext or legacy history', () => {
    const parsed = eventsFromFixture(XCHAT_ACTIVITY_FIXTURE_JSON).map((event) =>
      parseXActivityEvent(event, 'xchat_encrypted'),
    );
    expect(parsed).toHaveLength(2);
    for (const result of parsed) {
      expect(result).toMatchObject({
        kind: 'parsed',
        event: {
          namespace: 'xchat_encrypted',
          plaintextAvailability: 'unknown',
        },
      });
    }
    expect(
      parseXActivityEvent(
        eventsFromFixture(XCHAT_ACTIVITY_FIXTURE_JSON)[0],
        'legacy_dm',
      ),
    ).toMatchObject({ kind: 'unsupported', fact: 'unknown' });
  });

  it('converges out-of-order activity delivery deterministically', () => {
    const outOfOrderEvents = [
      ...eventsFromFixture(XCHAT_ACTIVITY_FIXTURE_JSON),
    ].reverse();
    const parsed = outOfOrderEvents.flatMap((event) => {
      const result = parseXActivityEvent(event, 'xchat_encrypted');
      return result.kind === 'parsed' ? [result.event] : [];
    });
    expect(
      deduplicateXActivityEvents(parsed).events.map(
        ({ providerEventId }) => providerEventId,
      ),
    ).toEqual(['activity-chat-1', 'activity-chat-2']);
  });
});
