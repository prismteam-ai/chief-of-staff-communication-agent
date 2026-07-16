import { describe, expect, it } from 'vitest';
import { deriveGmailAccountId } from './gmail-account.js';

describe('deriveGmailAccountId', () => {
  it('derives a stable id from the local part of the address', () => {
    expect(deriveGmailAccountId('demoalex775@gmail.com')).toBe('acct-gmail-demoalex775');
  });

  it('is case-insensitive', () => {
    expect(deriveGmailAccountId('DemoAlex775@Gmail.com')).toBe('acct-gmail-demoalex775');
  });

  it('slugifies non-alphanumeric characters in the local part', () => {
    expect(deriveGmailAccountId('demo.alex+cos@gmail.com')).toBe('acct-gmail-demo-alex-cos');
  });

  it('is deterministic across repeated calls (idempotent re-runs)', () => {
    const a = deriveGmailAccountId('demoalex775@gmail.com');
    const b = deriveGmailAccountId('demoalex775@gmail.com');
    expect(a).toBe(b);
  });

  it('throws for an address with no usable local part', () => {
    expect(() => deriveGmailAccountId('@gmail.com')).toThrow();
  });
});
