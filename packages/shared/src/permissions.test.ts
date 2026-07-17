import { describe, expect, it } from 'vitest';
import { assertAccountAccess, hasAccountAccess, AccountAccessDeniedError } from './permissions.js';
import type { AccountOwnershipMap } from './account.js';

const ownership: AccountOwnershipMap = {
  acct_1: 'user_a',
  acct_2: 'user_a',
  acct_3: 'user_b',
};

describe('hasAccountAccess (pure function, no AWS)', () => {
  it('returns true when the user owns the account', () => {
    expect(hasAccountAccess('user_a', 'acct_1', ownership)).toBe(true);
  });

  it('returns false when a different user owns the account', () => {
    expect(hasAccountAccess('user_b', 'acct_1', ownership)).toBe(false);
  });

  it('returns false for an unknown account id', () => {
    expect(hasAccountAccess('user_a', 'acct_unknown', ownership)).toBe(false);
  });
});

describe('assertAccountAccess', () => {
  it('does not throw when the user owns the account', () => {
    expect(() => assertAccountAccess('user_a', 'acct_2', ownership)).not.toThrow();
  });

  it('throws AccountAccessDeniedError when user A touches user B account', () => {
    expect(() => assertAccountAccess('user_a', 'acct_3', ownership)).toThrow(
      AccountAccessDeniedError,
    );
  });

  it('throws for an unknown account id', () => {
    expect(() => assertAccountAccess('user_a', 'acct_unknown', ownership)).toThrow(
      AccountAccessDeniedError,
    );
  });

  it('is a pure function — same inputs, same result, no side effects, no AWS calls', () => {
    const callOnce = () => {
      try {
        assertAccountAccess('user_b', 'acct_1', ownership);
        return 'no-throw';
      } catch (err) {
        return err instanceof AccountAccessDeniedError ? 'denied' : 'other';
      }
    };
    expect(callOnce()).toBe('denied');
    expect(callOnce()).toBe('denied');
  });
});
