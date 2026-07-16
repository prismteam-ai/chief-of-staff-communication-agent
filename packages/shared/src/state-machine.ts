/**
 * The communication state machine — design.md §5 "Data contracts" / §7 "Approval workflow".
 *
 * ```
 * ingested → recommended → drafted → awaiting_approval → approved → sent → answered
 *                │                        │ edited → awaiting_approval
 *                │                        │ rejected → drafted (re-draft)
 *                │ dismissed (no reply needed — FYI, newsletters)
 *                │ needs_context → drafted (after the user supplies context)
 * ```
 *
 * Terminal states: `answered` (entered on provider send confirmation) and `dismissed`. Both stop
 * the overdue clock — "answered" tracking counts handled = answered ∪ dismissed (see `isHandled`).
 *
 * This module is the single source of truth for legal transitions. The API (Task 6), the agent
 * (Task 5), and the dashboard (Task 8) all call `canTransition`/`applyTransition` rather than
 * re-encoding the graph — business rules never live in the prompt or the frontend (design.md §7).
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
] as const;

export type CommunicationState = (typeof COMMUNICATION_STATES)[number];

/**
 * Typed transition map: every state is an explicit key (exhaustively), and its value is the
 * exact set of legal destination states. `needs_context` is reachable via the confidence gate
 * (see `confidence.ts`) rather than a modeled inbound edge from another state — it is a routing
 * outcome of the recommend/draft step, not a transition target of an existing communication.
 */
export const TRANSITIONS: Readonly<Record<CommunicationState, readonly CommunicationState[]>> = {
  ingested: ['recommended'],
  recommended: ['drafted', 'dismissed'],
  drafted: ['awaiting_approval'],
  awaiting_approval: ['approved', 'edited', 'rejected'],
  approved: ['sent'],
  sent: ['answered'],
  edited: ['awaiting_approval'],
  rejected: ['drafted'],
  dismissed: [],
  needs_context: ['drafted'],
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
