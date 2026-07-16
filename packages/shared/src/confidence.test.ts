import { describe, expect, it } from 'vitest';
import {
  RecommendationSchema,
  DraftSchema,
  DEFAULT_CONFIDENCE_THRESHOLD,
  routeByConfidence,
} from './confidence.js';

describe('RecommendationSchema / DraftSchema — confidence gate contract', () => {
  it('accepts a recommendation carrying a confidence score in [0,1]', () => {
    const result = RecommendationSchema.safeParse({
      commId: 'comm_1',
      accountId: 'acct_1',
      actionType: 'reply',
      confidence: 0.82,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a confidence outside [0,1]', () => {
    expect(
      RecommendationSchema.safeParse({
        commId: 'c',
        accountId: 'a',
        actionType: 'reply',
        confidence: 1.5,
      }).success,
    ).toBe(false);
    expect(
      RecommendationSchema.safeParse({
        commId: 'c',
        accountId: 'a',
        actionType: 'reply',
        confidence: -0.1,
      }).success,
    ).toBe(false);
  });

  it('rejects a recommendation missing confidence', () => {
    const result = RecommendationSchema.safeParse({
      commId: 'comm_1',
      accountId: 'acct_1',
      actionType: 'reply',
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
