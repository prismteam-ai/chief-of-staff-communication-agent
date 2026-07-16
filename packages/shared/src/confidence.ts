import { z } from 'zod';
import { ActionTypeSchema } from './action-type.js';

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
