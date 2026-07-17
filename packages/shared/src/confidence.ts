import { z } from 'zod';
import { ActionTypeSchema, type ActionType } from './action-type.js';

/**
 * Confidence gate contract (design.md §5, §7): every recommendation/draft carries a `confidence`
 * score in `[0, 1]`. Below `DEFAULT_CONFIDENCE_THRESHOLD`, the communication routes to
 * `needs_context` instead of `drafted` so the dashboard prompts the user for more information
 * rather than presenting a low-confidence draft as if it were reliable (README L32).
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

const ConfidenceFieldSchema = z.number().min(0).max(1);

/**
 * The agent's structured recommendation (Task 5 brief constraint 7): `{ actionType, confidence,
 * rationale }` plus the identifying `commId`/`accountId`. `actionType` is the closed
 * {@link ActionTypeSchema} enum (not free text) so the classification is gradeable and every
 * consumer — dashboard, API, response-time metrics — can branch on a known set. `rationale` is the
 * model's one-line justification, surfaced to the user in the dashboard's recommended-actions view;
 * it carries no PII obligation beyond the message itself and is never used to make the routing
 * decision (that is `routeByConfidence`, applied in code on `confidence`).
 */
export const RecommendationSchema = z.object({
  commId: z.string().min(1),
  accountId: z.string().min(1),
  actionType: ActionTypeSchema,
  confidence: ConfidenceFieldSchema,
  rationale: z.string(),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const DraftSchema = z.object({
  commId: z.string().min(1),
  accountId: z.string().min(1),
  body: z.string(),
  confidence: ConfidenceFieldSchema,
});
export type Draft = z.infer<typeof DraftSchema>;

/**
 * Pure routing decision for the confidence gate: at/above threshold the communication proceeds to
 * `drafted`; below threshold it routes to `needs_context` (design.md §7's `needs_context → drafted`
 * edge is the recovery path once the user supplies the missing context).
 */
export function routeByConfidence(
  confidence: number,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): 'drafted' | 'needs_context' {
  return confidence >= threshold ? 'drafted' : 'needs_context';
}

/**
 * Action types that never warrant an auto-generated reply draft, regardless of confidence
 * (slowking fix 2 — closing the gap `state-machine.ts`'s doc comment already named: "Today's agent
 * always drafts once confidence clears the threshold, regardless of actionType"):
 *  - `fyi_no_reply` — no reply is owed at all (newsletters, notifications, CC-only threads). The
 *    state machine already documents `recommended -> dismissed` as this exact "no reply needed"
 *    outcome; routing here to `dismissed` instead of `drafted` makes the agent actually take that
 *    path instead of a human having to notice and dismiss a pointless draft.
 *  - `escalate` — urgent/high-stakes; the recommendation should surface to the principal, never an
 *    auto-drafted reply pretending to speak for them. Routed to `needs_context` (no draft, human
 *    must act) — reusing that existing state rather than adding a new one this batch.
 */
const NO_DRAFT_ACTION_TYPES: ReadonlySet<ActionType> = new Set(['fyi_no_reply', 'escalate']);

/** The full routing outcome `routeRecommendation` below decides between. */
export type RecommendationRoute = 'drafted' | 'needs_context' | 'dismissed';

/**
 * The FULL confidence-gate decision (slowking fix 2): two independent gates, both applied in code,
 * never in the prompt.
 *  1. Confidence below `threshold` -> `needs_context`, exactly as `routeByConfidence` alone decided
 *     — this always wins first: a low-confidence `fyi_no_reply`/`escalate` classification is itself
 *     uncertain and still needs a human to confirm, not a silent auto-dismiss.
 *  2. At/above threshold, `actionType` decides: `fyi_no_reply` -> `dismissed`, `escalate` ->
 *     `needs_context` (see {@link NO_DRAFT_ACTION_TYPES}); every other actionType (`reply_needed`,
 *     `schedule`, `delegate`) -> `drafted`, unchanged from the confidence-only gate.
 */
export function routeRecommendation(
  actionType: ActionType,
  confidence: number,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): RecommendationRoute {
  if (routeByConfidence(confidence, threshold) === 'needs_context') return 'needs_context';
  if (!NO_DRAFT_ACTION_TYPES.has(actionType)) return 'drafted';
  return actionType === 'fyi_no_reply' ? 'dismissed' : 'needs_context';
}
