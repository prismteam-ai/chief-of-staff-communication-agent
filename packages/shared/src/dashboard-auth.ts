import { z } from 'zod';

/**
 * Dashboard session-token contract (Task 8.5: closes the gap where `apps/web` sent a plain,
 * client-supplied `userId` on every tRPC call — anyone typing `userId: "demo-alex"` could act as
 * that user, server-side `assertAccountAccess` notwithstanding, because the `userId` itself was
 * never authenticated). This reuses the EXACT SAME token machinery Task 11 built for the MCP
 * server (`McpAuthService`/`McpTokenRecord`, DynamoDB `tokenHash` PK, SHA-256-only persistence) —
 * a dashboard session token IS an `McpTokenRecord` row, just issued via a credential-verified
 * `login` call instead of the (already-authenticated-by-being-in-the-dashboard) `issueMcpToken`
 * mint. One token table, one verification path, two issuance entry points — not a forked auth
 * system (brief constraint: "reuse the Task 11 MCP token mechanism — do NOT build a new auth
 * system").
 *
 * `login` is intentionally a single shared demo credential (username + password) mapped to a
 * fixed `userId` — the point is that the SERVER verifies a credential the client could not forge
 * before minting a token, not a full identity provider. See `dashboard-login-service.ts`.
 */
export const DashboardLoginInputSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type DashboardLoginInput = z.infer<typeof DashboardLoginInputSchema>;

export const DashboardLoginResultSchema = z.object({
  /** The plaintext session token — returned ONCE, at login, never retrievable again. Sent back on
   * every subsequent dashboard call as `Authorization: Bearer <token>`. */
  token: z.string().min(1),
  userId: z.string().min(1),
});
export type DashboardLoginResult = z.infer<typeof DashboardLoginResultSchema>;

export class DashboardLoginInvalidError extends Error {
  constructor() {
    super('Invalid username or password.');
    this.name = 'DashboardLoginInvalidError';
  }
}
