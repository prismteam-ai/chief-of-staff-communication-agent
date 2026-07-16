import { describe, expect, it } from 'vitest';
import {
  COMMUNICATION_STATES,
  TRANSITIONS,
  canTransition,
  isHandled,
  isTerminal,
  type CommunicationState,
} from './state-machine.js';

/** The exact legal-edge list the state machine must accept, per design.md §5/§7. */
const LEGAL_TRANSITIONS: Array<[CommunicationState, CommunicationState]> = [
  ['ingested', 'recommended'],
  ['recommended', 'drafted'],
  ['recommended', 'dismissed'],
  ['recommended', 'needs_context'],
  ['drafted', 'awaiting_approval'],
  ['drafted', 'dismissed'],
  ['awaiting_approval', 'approved'],
  ['awaiting_approval', 'edited'],
  ['awaiting_approval', 'rejected'],
  ['approved', 'sent'],
  ['sent', 'answered'],
  ['edited', 'awaiting_approval'],
  ['rejected', 'drafted'],
  ['needs_context', 'drafted'],
];

describe('COMMUNICATION_STATES', () => {
  it('includes every state named in design.md §5/§7', () => {
    const expected = [
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
    ].sort();
    expect([...COMMUNICATION_STATES].sort()).toEqual(expected);
  });
});

describe('canTransition — exhaustive state x state matrix', () => {
  const legalSet = new Set(LEGAL_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

  for (const from of COMMUNICATION_STATES) {
    for (const to of COMMUNICATION_STATES) {
      const key = `${from}->${to}`;
      const expected = legalSet.has(key);
      it(`${expected ? 'accepts' : 'rejects'} ${key}`, () => {
        expect(canTransition(from, to)).toBe(expected);
      });
    }
  }

  it('accepts every transition in the legal list', () => {
    for (const [from, to] of LEGAL_TRANSITIONS) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it('rejects self-transitions that are not explicitly modeled', () => {
    for (const state of COMMUNICATION_STATES) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it('rejects transitions out of terminal states', () => {
    expect(canTransition('answered', 'sent')).toBe(false);
    expect(canTransition('answered', 'recommended')).toBe(false);
    expect(canTransition('dismissed', 'drafted')).toBe(false);
    expect(canTransition('dismissed', 'ingested')).toBe(false);
  });
});

describe('TRANSITIONS map', () => {
  it('exposes exactly the legal destinations for each state', () => {
    for (const state of COMMUNICATION_STATES) {
      const expectedDestinations = LEGAL_TRANSITIONS.filter(([from]) => from === state).map(
        ([, to]) => to,
      );
      expect([...TRANSITIONS[state]].sort()).toEqual([...expectedDestinations].sort());
    }
  });

  it('is exhaustively keyed over every state (no missing entries)', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...COMMUNICATION_STATES].sort());
  });
});

describe('isTerminal / isHandled — overdue-clock semantics', () => {
  it('answered and dismissed are terminal', () => {
    expect(isTerminal('answered')).toBe(true);
    expect(isTerminal('dismissed')).toBe(true);
  });

  it('every other state is non-terminal', () => {
    const nonTerminal = COMMUNICATION_STATES.filter((s) => s !== 'answered' && s !== 'dismissed');
    for (const state of nonTerminal) {
      expect(isTerminal(state)).toBe(false);
    }
  });

  it('isHandled is exactly the terminal set (answered ∪ dismissed stop the overdue clock)', () => {
    for (const state of COMMUNICATION_STATES) {
      expect(isHandled(state)).toBe(isTerminal(state));
    }
    expect(isHandled('answered')).toBe(true);
    expect(isHandled('dismissed')).toBe(true);
    expect(isHandled('awaiting_approval')).toBe(false);
    expect(isHandled('sent')).toBe(false);
  });
});
