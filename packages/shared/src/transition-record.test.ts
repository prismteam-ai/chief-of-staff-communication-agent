import { describe, expect, it } from 'vitest';
import {
  TransitionRecordSchema,
  applyTransition,
  TransitionRejectedError,
} from './transition-record.js';

describe('TransitionRecordSchema', () => {
  it('accepts a valid transition record with a timestamp', () => {
    const result = TransitionRecordSchema.safeParse({
      commId: 'comm_123',
      accountId: 'acct_1',
      from: 'drafted',
      to: 'awaiting_approval',
      ts: '2026-07-15T12:00:00.000Z',
      actorId: 'user_1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a record missing ts (every transition must carry a timestamp)', () => {
    const result = TransitionRecordSchema.safeParse({
      commId: 'comm_123',
      accountId: 'acct_1',
      from: 'drafted',
      to: 'awaiting_approval',
      actorId: 'user_1',
    });
    expect(result.success).toBe(false);
  });
});

describe('applyTransition', () => {
  it('returns a timestamped transition record for a legal move', () => {
    const record = applyTransition({
      commId: 'comm_123',
      accountId: 'acct_1',
      from: 'ingested',
      to: 'recommended',
      actorId: 'system',
    });
    expect(record.from).toBe('ingested');
    expect(record.to).toBe('recommended');
    expect(() => new Date(record.ts).toISOString()).not.toThrow();
  });

  it('throws TransitionRejectedError for an illegal move', () => {
    expect(() =>
      applyTransition({
        commId: 'comm_123',
        accountId: 'acct_1',
        from: 'answered',
        to: 'sent',
        actorId: 'system',
      }),
    ).toThrow(TransitionRejectedError);
  });
});
