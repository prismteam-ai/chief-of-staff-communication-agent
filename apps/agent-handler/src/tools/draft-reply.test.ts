import { describe, expect, it } from 'vitest';
import { DraftSchema } from '@chief-of-staff/shared';
import { shapeDraft, buildStyleInstructions } from './draft-reply.js';
import { GENERIC_STYLE_CARD } from './style-profile.js';

const ctx = { commId: 'gmail#abc', accountId: 'acct-1' };

describe('shapeDraft — shapes a model output into the shared Draft', () => {
  it('produces a Draft that validates against the shared schema', () => {
    const draft = shapeDraft(ctx, {
      body: 'Thanks for reaching out — happy to help. Best, Alex',
      confidence: 0.77,
    });
    expect(DraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.commId).toBe('gmail#abc');
    expect(draft.body).toContain('Thanks');
  });

  it('rejects an out-of-range confidence', () => {
    expect(() => shapeDraft(ctx, { body: 'hi', confidence: -0.2 })).toThrow();
  });
});

describe('buildStyleInstructions — exercises the style seam (Task 10 fills it in)', () => {
  it('falls back to the generic v0 style card when no profile exists (seam returns null today)', () => {
    // getStyleProfile returns null in Task 5, so the generic card is used — the seam is exercised,
    // not hardcoded around.
    expect(buildStyleInstructions('user-1')).toBe(GENERIC_STYLE_CARD);
    expect(buildStyleInstructions(undefined)).toBe(GENERIC_STYLE_CARD);
  });
});
