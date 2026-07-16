/**
 * The communication state machine — design.md §5 "Data contracts" / §7 "Approval workflow".
 *
 * ```
 * ingested → recommended → drafted → awaiting_approval → approved → sent → answered
 *                │                        │ edited → awaiting_approval
 *                │                        │ rejected → drafted (re-draft)
 *                │ dismissed (no reply needed — FYI, newsletters)
 *                │ needs_context → awaiting_reprocess → recommended (agent re-run with the
 *                │                                       supplied context)
 * ```
 *
 * The `recommended → needs_context` edge is the confidence gate's low-confidence outcome (see
 * `confidence.ts`/`routeByConfidence`): once the agent has produced a recommendation but its
 * confidence is below threshold, the communication moves to `needs_context` rather than `drafted`,
 * and the dashboard prompts the user. The gate DECISION is always applied in code, never in the
 * prompt.
 *
 * ## `needs_context → awaiting_reprocess → recommended` (Task 6 fix)
 * `needs_context` used to exit straight back to `drafted` on `supplyContext` alone — but a
 * `needs_context` record has NO draft (the agent never got far enough to write one), so that edge
 * landed a draftless record in `drafted`, where the UI's approve action has nothing to approve.
 * `supplyContext` now persists the supplied text on the record and re-enqueues the agent turn
 * (`AGENT_QUEUE_URL`) instead, marking the record `awaiting_reprocess` as a state marker for "context
 * supplied, agent re-run pending" — a fire-and-forget hand-off mirroring the ingest→agent trigger
 * (`apps/ingest/src/agent-trigger.ts`). The re-run agent turn re-enters at `awaiting_reprocess →
 * recommended`, threading the supplied context into the classify/draft prompt, and then proceeds
 * through the SAME `recommended → drafted` / `recommended → needs_context` fork the first pass used —
 * so a still-low-confidence re-run correctly lands back in `needs_context` (with the context
 * preserved) rather than being forced into `drafted` regardless of outcome.
 *
 * Terminal states: `answered` (entered on provider send confirmation) and `dismissed`. Both stop
 * the overdue clock — "answered" tracking counts handled = answered ∪ dismissed (see `isHandled`).
 *
 * ## `drafted → dismissed` (Task 6 addition)
 * design.md §7 documents `dismissed` primarily as a `recommended`-state outcome ("no reply needed —
 * FYI, newsletters"), i.e. the agent ideally never even drafts a reply for an `fyi_no_reply`
 * classification. Today's agent (Task 5) always drafts once confidence clears the threshold,
 * regardless of `actionType` — a real gap, tracked for a future tightening of the confidence-gate
 * routing (it should also branch on `actionType`, not confidence alone). Until then, a human
 * reviewing the approval queue needs a way to dismiss a communication that reached `drafted` but
 * turns out not to need a reply (exactly the `fyi_no_reply` case) — the additive edge below is that
 * escape hatch. It does not remove or replace `recommended → dismissed`; both remain legal.
 */

export const COMMUNICATION_STATES = [
  'ingested',
  'recommended',
  'drafted',
  'awaiting_approval',
  'approved',
  'sent',
  'answered',
  'edited',
  'rejected',
  'dismissed',
  'needs_context',
  'awaiting_reprocess',
] as const;

export type CommunicationState = (typeof COMMUNICATION_STATES)[number];

/**
 * Typed transition map: every state is an explicit key (exhaustively), and its value is the
 * exact set of legal destination states. `needs_context` is entered as the confidence gate's
 * low-confidence outcome of the recommend step (`recommended → needs_context`, see `confidence.ts`)
 * — the gate decision is applied in code, not modeled as branch logic in the graph — and exits to
 * `awaiting_reprocess` once the user supplies the missing context (`supplyContext`), which the
 * re-triggered agent turn then advances back through `recommended` into either `drafted` or
 * (still-low-confidence) `needs_context` again — see the doc comment above.
 */
export const TRANSITIONS: Readonly<Record<CommunicationState, readonly CommunicationState[]>> = {
  ingested: ['recommended'],
  recommended: ['drafted', 'dismissed', 'needs_context'],
  // `dismissed` here is the Task 6 addition documented above — a human dismissing an
  // already-drafted communication that turns out not to need a reply.
  drafted: ['awaiting_approval', 'dismissed'],
  awaiting_approval: ['approved', 'edited', 'rejected'],
  approved: ['sent'],
  sent: ['answered'],
  edited: ['awaiting_approval'],
  rejected: ['drafted'],
  dismissed: [],
  needs_context: ['awaiting_reprocess'],
  // Entered only by `supplyContext`; exits once the re-enqueued agent turn re-classifies with the
  // supplied context (mirrors the `ingested → recommended` first-pass hop).
  awaiting_reprocess: ['recommended'],
  answered: [],
};

/** Pure guard: is `from -> to` a legal transition? No side effects, no AWS. */
export function canTransition(from: CommunicationState, to: CommunicationState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Terminal semantics: `answered` and `dismissed` are the only states with no outbound edges —
 * both stop the overdue clock.
 */
export function isTerminal(state: CommunicationState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** Alias naming the product meaning of `isTerminal` for response-time-metrics call sites. */
export function isHandled(state: CommunicationState): boolean {
  return isTerminal(state);
}
