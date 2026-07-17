import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { DraftSchema, type Draft } from '@chief-of-staff/shared';
import {
  getStyleProfile,
  GENERIC_STYLE_CARD,
  type GetStyleProfileDeps,
  type StyleProfile,
} from './style-profile.js';

/**
 * `draftReply` (design.md §5 tool list). Produces a context-and-style-aware reply draft. Like
 * `recommendAction`, the draft TEXT is produced as the agent's structured output (`agent.ts`); this
 * module owns (a) the style seam and (b) shaping/validating the model's `{body, confidence}` into
 * the shared `Draft` (adding `commId`/`accountId` in code). The `tool()` form is the shared typed
 * contract for the API/MCP server; its `execute` shapes + validates only.
 *
 * Style is real as of Task 10 (see `style-profile.ts`): `getStyleProfile` looks up the user's
 * learned style card + retrieves embedded exemplars of their own past sent replies; absent a
 * profile (no `userId`, or `build-style-profile` never run for this user) it falls back to
 * `GENERIC_STYLE_CARD`, exactly as Task 5 left it.
 */

/**
 * The model-produced part of a draft — ids added in code, not asked of the model.
 *
 * `confidence` is a plain `z.number()` (no `.min/.max`) for the same Bedrock structured-output
 * reason as `RecommendationOutputSchema`; the `[0,1]` bound is enforced in code by `shapeDraft`
 * re-parsing through the shared `DraftSchema`.
 */
export const DraftOutputSchema = z.object({
  body: z.string().describe('The full reply body text. Plain business prose, ready to send.'),
  confidence: z
    .number()
    .describe('How confident you are this draft is appropriate to send, from 0 to 1 (in [0,1]).'),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

export interface DraftReplyContext {
  commId: string;
  accountId: string;
  /** Owning user, used to look up the (Task 10) style profile. Optional until accounts wire it. */
  userId?: string;
}

/**
 * Builds the style instructions injected into the draft prompt. Exercises the style seam
 * (`getStyleProfile`) so the fallback path is real, not hardcoded around: a real profile's style
 * card + exemplars are appended when present; otherwise the generic v0 card is used alone.
 */
export async function buildStyleInstructions(
  userId: string | undefined,
  deps: GetStyleProfileDeps,
): Promise<string> {
  const profile: StyleProfile | null = await getStyleProfile(userId, deps);
  if (!profile) {
    return GENERIC_STYLE_CARD;
  }
  const exemplarBlock =
    profile.exemplars.length > 0
      ? `\n\nExamples of this user's own prior replies to match in voice:\n${profile.exemplars.join('\n---\n')}`
      : '';
  return `${profile.styleCard}${exemplarBlock}`;
}

/**
 * Shapes a model-produced `{body, confidence}` into the full `Draft` and validates it against the
 * shared schema. Throws on an invalid shape (same rationale as `shapeRecommendation`).
 */
export function shapeDraft(ctx: DraftReplyContext, output: DraftOutput): Draft {
  return DraftSchema.parse({
    commId: ctx.commId,
    accountId: ctx.accountId,
    body: output.body,
    confidence: output.confidence,
  });
}

export function createDraftReplyTool(ctx: DraftReplyContext): Tool {
  return tool({
    description:
      'Record the drafted reply for the communication being triaged: the full body text and a ' +
      'confidence score in [0,1]. Match the requested voice and ground the draft in retrieved ' +
      'context; never invent facts.',
    inputSchema: DraftOutputSchema,
    execute: async (output) => shapeDraft(ctx, output),
  });
}
