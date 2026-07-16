import { z } from 'zod';

/**
 * The recommended-action taxonomy (design.md §5 "Agent brain", README L26). Every inbound
 * communication the agent triages is classified into exactly one of these six action types — the
 * structured, gradeable output the confidence gate then routes on (see `confidence.ts`).
 *
 * This is a closed enum on purpose (Task 5 brief constraint 7): a free-text action label would let
 * the model invent categories the dashboard, the API, and the response-time metrics cannot reason
 * over. The set is deliberately small and mutually exhaustive for a chief-of-staff triage loop:
 *
 *  - `reply_needed`   — the sender expects a response from us; a draft should be produced.
 *  - `fyi_no_reply`   — informational (newsletters, notifications, CC-only threads); no reply owed.
 *  - `schedule`       — the message is a meeting/calendar request needing a scheduling action.
 *  - `delegate`       — the work belongs to someone else; hand it off (a follow-up, not a reply).
 *  - `escalate`       — urgent / high-stakes; surface to the principal rather than auto-handling.
 *  - `needs_context`  — the agent cannot classify/act confidently yet and needs more information.
 *
 * `needs_context` appears here as a first-class action type (the model may explicitly choose it)
 * AND is independently the destination the confidence gate routes to when any recommendation's
 * confidence falls below threshold — the two paths converge on the same communication state, but
 * the gate decision is always applied in code (`routeByConfidence`), never asked of the prompt.
 */
export const ACTION_TYPES = [
  'reply_needed',
  'fyi_no_reply',
  'schedule',
  'delegate',
  'escalate',
  'needs_context',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/** Zod enum over {@link ACTION_TYPES} — the single validator every producer/consumer shares. */
export const ActionTypeSchema = z.enum(ACTION_TYPES);
