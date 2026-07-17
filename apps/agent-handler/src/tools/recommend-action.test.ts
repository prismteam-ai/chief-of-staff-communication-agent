import { describe, expect, it } from 'vitest';
import { RecommendationSchema } from '@chief-of-staff/shared';
import { shapeRecommendation, RecommendationOutputSchema } from './recommend-action.js';

const ctx = { commId: 'gmail#abc', accountId: 'acct-1' };

describe('shapeRecommendation — shapes a model output into the shared Recommendation', () => {
  it('produces a Recommendation that validates against the shared schema', () => {
    const rec = shapeRecommendation(ctx, {
      actionType: 'reply_needed',
      confidence: 0.83,
      rationale: 'Sender asks a direct question.',
    });
    expect(RecommendationSchema.safeParse(rec).success).toBe(true);
    expect(rec.commId).toBe('gmail#abc');
    expect(rec.accountId).toBe('acct-1');
    expect(rec.actionType).toBe('reply_needed');
  });

  it('rejects an out-of-enum action type (not silently passed through)', () => {
    // A model that returned an invalid action type must be caught, not persisted.
    expect(() =>
      shapeRecommendation(ctx, {
        // @ts-expect-error — deliberately invalid to prove the schema rejects it at runtime.
        actionType: 'reply',
        confidence: 0.9,
        rationale: 'x',
      }),
    ).toThrow();
  });

  it('rejects a missing / out-of-range confidence', () => {
    expect(() =>
      shapeRecommendation(ctx, {
        actionType: 'reply_needed',
        confidence: 1.5,
        rationale: 'x',
      }),
    ).toThrow();
  });

  it('the model-output schema itself rejects an out-of-enum action type', () => {
    const parsed = RecommendationOutputSchema.safeParse({
      actionType: 'nonsense',
      confidence: 0.5,
      rationale: 'x',
    });
    expect(parsed.success).toBe(false);
  });
});
