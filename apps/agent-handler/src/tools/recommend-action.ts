import { tool, type Tool } from 'ai';
import { z } from 'zod';
import {
  ActionTypeSchema,
  RecommendationSchema,
  type Recommendation,
} from '@chief-of-staff/shared';

/**
 * `recommendAction` (design.md §5 tool list). Classifies the inbound communication into one of the
 * six `ActionType` values with a confidence score and a rationale.
 *
 * ## Design choice: structured OUTPUT, not an LLM-in-a-tool
 * `recommendAction`'s `execute` does NOT call the model again. The classification is produced as
 * the agent's final structured output (`Output.object(RecommendationOutputSchema)` in `agent.ts`),
 * which the AI SDK validates for us — running a nested LLM call inside a tool would be the
 * anti-pattern the kit skill warns against ("do NOT create multi-function tools"; "the agent
 * handles the loop"). The `tool()` form here is the shared, typed contract (design.md §5: "one
 * list, shared by the agent, the tRPC API, and the MCP server"): its `execute` only SHAPES and
 * validates a `{actionType, confidence, rationale}` payload into the full `Recommendation` (adding
 * `commId`/`accountId` from bound context), so the API and MCP server can call the same tool later
 * with an already-decided classification. The confidence GATE decision is never here — it is
 * applied in code by `routeByConfidence` in `run-agent-turn.ts` (Task 5 constraint 3).
 */

/**
 * The model-produced part of a recommendation — ids are added in code, not asked of the model.
 *
 * NOTE: `confidence` is a plain `z.number()` here, NOT `.min(0).max(1)`. Bedrock's structured-output
 * JSON schema rejects `minimum`/`maximum` on a `number` type (`output_config.format.schema: For
 * 'number' type, properties maximum, minimum are not supported`). The `[0,1]` bound is still
 * enforced — in code, by `shapeRecommendation` re-parsing through the shared `RecommendationSchema`
 * (which DOES bound it) — so an out-of-range model value is rejected there, not silently accepted.
 */
export const RecommendationOutputSchema = z.object({
  actionType: ActionTypeSchema.describe(
    'The single best action category for this communication: reply_needed, fyi_no_reply, ' +
      'schedule, delegate, escalate, or needs_context.',
  ),
  confidence: z
    .number()
    .describe('How confident you are in this classification, from 0 to 1 (a value in [0,1]).'),
  rationale: z
    .string()
    .describe('One concise sentence justifying the classification. No message body verbatim.'),
});
export type RecommendationOutput = z.infer<typeof RecommendationOutputSchema>;

export interface RecommendActionContext {
  commId: string;
  accountId: string;
}

/**
 * Shapes a model-produced `{actionType, confidence, rationale}` into the full `Recommendation`
 * (adding the bound `commId`/`accountId`) and validates it against the shared schema. Throwing here
 * is deliberate: an out-of-enum action type or an out-of-range confidence must not pass silently —
 * the caller catches it and fails the turn visibly (`AgentTurnFailed`) rather than persisting a
 * malformed recommendation.
 */
export function shapeRecommendation(
  ctx: RecommendActionContext,
  output: RecommendationOutput,
): Recommendation {
  return RecommendationSchema.parse({
    commId: ctx.commId,
    accountId: ctx.accountId,
    actionType: output.actionType,
    confidence: output.confidence,
    rationale: output.rationale,
  });
}

export function createRecommendActionTool(ctx: RecommendActionContext): Tool {
  return tool({
    description:
      'Record the recommended action for the communication being triaged: its action type, a ' +
      'confidence score in [0,1], and a one-sentence rationale. Choose exactly one action type.',
    inputSchema: RecommendationOutputSchema,
    // Shapes + validates only; never calls the model. Returns the full Recommendation.
    execute: async (output) => shapeRecommendation(ctx, output),
  });
}
