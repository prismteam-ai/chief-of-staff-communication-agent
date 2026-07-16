import { describe, expect, it } from 'vitest';
import {
  RecommendationSchema,
  DraftSchema,
  DEFAULT_CONFIDENCE_THRESHOLD,
  routeByConfidence,
} from './confidence.js';
import { ACTION_TYPES } from './action-type.js';

describe('RecommendationSchema / DraftSchema — confidence gate contract', () => {
  it('accepts a recommendation carrying an enum actionType, confidence in [0,1], and a rationale', () => {
    const result = RecommendationSchema.safeParse({
      commId: 'comm_1',
      accountId: 'acct_1',
      actionType: 'reply_needed',
      confidence: 0.82,
      rationale: 'Sender asks a direct question and expects an answer.',
    });
    expect(result.success).toBe(true);
  });

  it('accepts every declared ActionType enum member', () => {
    for (const actionType of ACTION_TYPES) {
      const result = RecommendationSchema.safeParse({
        commId: 'comm_1',
        accountId: 'acct_1',
        actionType,
        confidence: 0.7,
        rationale: 'r',
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an actionType outside the enum', () => {
    // The old free-text placeholder value — must now fail validation (brief constraint 7).
    const result = RecommendationSchema.safeParse({
      commId: 'comm_1',
      accountId: 'acct_1',
      actionType: 'reply',
      confidence: 0.7,
      rationale: 'r',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a recommendation missing rationale', () => {
    const result = RecommendationSchema.safeParse({
      commId: 'comm_1',
      accountId: 'acct_1',
      actionType: 'reply_needed',
      confidence: 0.7,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a confidence outside [0,1]', () => {
    expect(
      RecommendationSchema.safeParse({
        commId: 'c',
        accountId: 'a',
        actionType: 'reply_needed',
        confidence: 1.5,
        rationale: 'r',
      }).success,
    ).toBe(false);
    expect(
      RecommendationSchema.safeParse({
        commId: 'c',
        accountId: 'a',
        actionType: 'reply_needed',
        confidence: -0.1,
        rationale: 'r',
      }).success,
    ).toBe(false);
  });

  it('rejects a recommendation missing confidence', () => {
    const result = RecommendationSchema.safeParse({
      commId: 'comm_1',
      accountId: 'acct_1',
      actionType: 'reply_needed',
      rationale: 'r',
    });
    expect(result.success).toBe(false);
  });

  it('DraftSchema also requires confidence', () => {
    const result = DraftSchema.safeParse({
      commId: 'comm_1',
      accountId: 'acct_1',
      body: 'Thanks for reaching out.',
      confidence: 0.9,
    });
    expect(result.success).toBe(true);
  });
});

describe('routeByConfidence', () => {
  it('routes at/above the default threshold to drafted', () => {
    expect(routeByConfidence(DEFAULT_CONFIDENCE_THRESHOLD)).toBe('drafted');
    expect(routeByConfidence(1)).toBe('drafted');
  });

  it('routes below the default threshold to needs_context', () => {
    expect(routeByConfidence(DEFAULT_CONFIDENCE_THRESHOLD - 0.01)).toBe('needs_context');
    expect(routeByConfidence(0)).toBe('needs_context');
  });

  it('honors an explicit custom threshold', () => {
    expect(routeByConfidence(0.5, 0.6)).toBe('needs_context');
    expect(routeByConfidence(0.6, 0.6)).toBe('drafted');
  });
});
