import { z } from 'zod';
import { COMMUNICATION_STATES, canTransition, type CommunicationState } from './state-machine.js';

/**
 * Every transition record carries a timestamp (design.md §5) — this feeds response-time metrics
 * (design.md §7 "response-time metrics at every transition"). Persisted as a DynamoDB conditional
 * write keyed on `commId` + `from` state so a duplicate/concurrent transition attempt fails closed
 * rather than double-applying (design.md §7 "DynamoDB conditional writes").
 */
export const TransitionRecordSchema = z.object({
  commId: z.string().min(1),
  accountId: z.string().min(1),
  from: z.enum(COMMUNICATION_STATES),
  to: z.enum(COMMUNICATION_STATES),
  ts: z.string().datetime(),
  /** Who/what caused the transition — a user id, or `"system"` for agent/pipeline-driven moves. */
  actorId: z.string().min(1),
});

export type TransitionRecord = z.infer<typeof TransitionRecordSchema>;

export class TransitionRejectedError extends Error {
  constructor(
    public readonly from: CommunicationState,
    public readonly to: CommunicationState,
  ) {
    super(`Illegal state transition: ${from} -> ${to}`);
    this.name = 'TransitionRejectedError';
  }
}

export interface ApplyTransitionInput {
  commId: string;
  accountId: string;
  from: CommunicationState;
  to: CommunicationState;
  actorId: string;
  /** Injectable clock for deterministic tests; defaults to the real current time. */
  now?: () => Date;
}

/**
 * Validates the move against `canTransition` and returns a timestamped `TransitionRecord`.
 * Pure aside from the clock — no AWS calls here; the DynamoDB conditional-write persistence is a
 * later task's concern (Task 6), this module only owns the transition's legality and shape.
 */
export function applyTransition(input: ApplyTransitionInput): TransitionRecord {
  const { commId, accountId, from, to, actorId, now = () => new Date() } = input;

  if (!canTransition(from, to)) {
    throw new TransitionRejectedError(from, to);
  }

  return TransitionRecordSchema.parse({
    commId,
    accountId,
    from,
    to,
    actorId,
    ts: now().toISOString(),
  });
}
