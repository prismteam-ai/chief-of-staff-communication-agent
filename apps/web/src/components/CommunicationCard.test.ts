import { describe, expect, it } from 'vitest';
import type { CommunicationDto } from '../lib/trpc-client.js';
import { canApproveCommunication } from './CommunicationCard.js';

/**
 * Pure-logic coverage for the Approve-button gate (Task 6 review fix). No rendering harness is
 * needed — `canApproveCommunication` is a pure function of `{status, draft}`, extracted from
 * `CommunicationCard` specifically so this regression is testable without standing up a full
 * React Testing Library + jsdom pipeline for one predicate.
 */

function draftOf(body: string): CommunicationDto['draft'] {
  return { commId: 'gmail#1', accountId: 'acct-1', body, confidence: 0.8 };
}

describe('canApproveCommunication', () => {
  it('is false for a needs_context record even if status were somehow drafted with no draft body', () => {
    // The regression case: a needs_context record that reached `drafted` (e.g. via the old
    // supplyContext shortcut) with no draft ever produced — must never be approvable.
    expect(canApproveCommunication({ status: 'drafted', draft: undefined })).toBe(false);
  });

  it('is false for drafted with an empty/whitespace-only draft body', () => {
    expect(canApproveCommunication({ status: 'drafted', draft: draftOf('') })).toBe(false);
    expect(canApproveCommunication({ status: 'drafted', draft: draftOf('   ') })).toBe(false);
  });

  it('is true for drafted with a real draft body', () => {
    expect(canApproveCommunication({ status: 'drafted', draft: draftOf('Sure, noted.') })).toBe(
      true,
    );
  });

  it('is true for awaiting_approval with a real draft body', () => {
    expect(
      canApproveCommunication({ status: 'awaiting_approval', draft: draftOf('Sure, noted.') }),
    ).toBe(true);
  });

  it('is false for awaiting_approval with no draft (defensive — should not happen)', () => {
    expect(canApproveCommunication({ status: 'awaiting_approval', draft: undefined })).toBe(false);
  });

  it('is false for every other status regardless of draft presence', () => {
    const statuses: CommunicationDto['status'][] = [
      'ingested',
      'recommended',
      'approved',
      'sent',
      'answered',
      'edited',
      'rejected',
      'dismissed',
      'needs_context',
      'awaiting_reprocess',
    ];
    for (const status of statuses) {
      expect(canApproveCommunication({ status, draft: draftOf('Has a body.') })).toBe(false);
    }
  });
});
