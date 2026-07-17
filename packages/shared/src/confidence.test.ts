import { describe, expect, it } from 'vitest';
import {
  RecommendationSchema,
  DraftSchema,
  DEFAULT_CONFIDENCE_THRESHOLD,
  routeByConfidence,
  routeRecommendation,
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

describe('routeRecommendation — confidence + actionType gate (slowking fix 2)', () => {
  it('reply_needed and schedule at/above threshold still route to drafted (does not break the existing drafted path)', () => {
    expect(routeRecommendation('reply_needed', 0.9)).toBe('drafted');
    expect(routeRecommendation('schedule', 0.9)).toBe('drafted');
    expect(routeRecommendation('delegate', 0.9)).toBe('drafted');
  });

  it('fyi_no_reply at/above threshold routes to dismissed, not drafted — no reply is owed', () => {
    expect(routeRecommendation('fyi_no_reply', 0.9)).toBe('dismissed');
    expect(routeRecommendation('fyi_no_reply', DEFAULT_CONFIDENCE_THRESHOLD)).toBe('dismissed');
  });

  it('escalate at/above threshold routes to needs_context, not drafted — no auto-reply', () => {
    expect(routeRecommendation('escalate', 0.9)).toBe('needs_context');
  });

  it('confidence below threshold always wins first, regardless of actionType', () => {
    // Even a low-confidence fyi_no_reply/escalate must still land in needs_context — the
    // classification itself is uncertain, so it is not safe to silently auto-dismiss.
    expect(routeRecommendation('fyi_no_reply', 0.1)).toBe('needs_context');
    expect(routeRecommendation('escalate', 0.1)).toBe('needs_context');
    expect(routeRecommendation('reply_needed', 0.1)).toBe('needs_context');
  });

  it('honors an explicit custom threshold', () => {
    expect(routeRecommendation('reply_needed', 0.5, 0.6)).toBe('needs_context');
    expect(routeRecommendation('reply_needed', 0.6, 0.6)).toBe('drafted');
  });
});
