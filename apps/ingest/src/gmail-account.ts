/**
 * Deterministic accountId derivation for a connected Gmail mailbox (brief constraint 5:
 * "accountId derived from the address"). Kept in one place so `just gmail-auth`, the poller, and
 * any future lookup all agree on the same id for the same address without a round-trip.
 */
export function deriveGmailAccountId(address: string): string {
  const localPart = address
    .trim()
    .toLowerCase()
    .split('@')[0]
    ?.replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!localPart) {
    throw new Error(`Cannot derive an accountId from address "${address}"`);
  }

  return `acct-gmail-${localPart}`;
}
