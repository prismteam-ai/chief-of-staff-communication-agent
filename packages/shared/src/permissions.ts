import type { AccountOwnershipMap } from './account.js';

/**
 * Per-user permission boundary (design.md §10, README L41-L42): a user only ever sees and acts on
 * their own connected accounts. `hasAccountAccess`/`assertAccountAccess` are pure functions — no
 * AWS calls — so every future read/write path (tRPC procedures in Task 6/8, the MCP server in Task
 * 11, the agent tools in Task 5) can share and unit-test this one guard instead of re-deriving the
 * check inline.
 */
export class AccountAccessDeniedError extends Error {
  constructor(
    public readonly userId: string,
    public readonly accountId: string,
  ) {
    super(`User "${userId}" does not have access to account "${accountId}"`);
    this.name = 'AccountAccessDeniedError';
  }
}

/** Pure boolean check: does `userId` own `accountId`? Unknown accounts are always denied. */
export function hasAccountAccess(
  userId: string,
  accountId: string,
  ownership: AccountOwnershipMap,
): boolean {
  return ownership[accountId] === userId;
}

/**
 * Guard form: throws `AccountAccessDeniedError` instead of returning `false`, for call sites (tRPC
 * procedures, MCP tool handlers) that want to fail closed with one line rather than an `if`.
 */
export function assertAccountAccess(
  userId: string,
  accountId: string,
  ownership: AccountOwnershipMap,
): void {
  if (!hasAccountAccess(userId, accountId, ownership)) {
    throw new AccountAccessDeniedError(userId, accountId);
  }
}
