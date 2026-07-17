import { z } from 'zod';

/**
 * Per-user bearer token contract (Task 11, design.md §8: "calling the hosted API with a per-user
 * scoped token issued in the dashboard"; generalized in Task 8.5 to also back dashboard sessions —
 * see `dashboard-auth.ts`). The Cursor MCP server has no AWS credentials, and (as of Task 8.5) the
 * web dashboard is held to the exact same standard: every call authenticates with an opaque
 * bearer token instead of a client-supplied `userId`. The token maps to exactly one `userId`
 * server-side, so every token-authenticated call — MCP tool invocation or dashboard tRPC call —
 * is scoped by the SAME account-permission guard (`assertAccountAccess`) every read/write path
 * already enforces (design.md §10) — a forged or another user's token can never widen access,
 * because the `userId` a procedure acts as comes from the verified token, not from anything the
 * caller asserts.
 *
 * ## Storage shape (`McpTokenRecord`)
 * One table, one shape, two issuance entry points: `issueMcpToken` (Task 11, dashboard-facing mint
 * for the MCP server) and `login` (Task 8.5, credential-verified mint for the dashboard's own
 * session) both produce an `McpTokenRecord` row, distinguished only by `label` (e.g. "Cursor
 * desktop" vs "dashboard session"). Only the SHA-256 hash of the token is ever persisted
 * (`tokenHash`, DynamoDB PK) — the same "never the secret itself" discipline
 * `Account.credentialSecretArn` uses for provider credentials (design.md §10: "no secret in code,
 * logs, or the client bundle"). The plaintext token is shown to the caller exactly once, at
 * issuance time, then never persisted or logged anywhere again.
 */
export const McpTokenRecordSchema = z.object({
  /** SHA-256 hex digest of the plaintext token — the DynamoDB partition key. Never the raw token. */
  tokenHash: z.string().min(1),
  userId: z.string().min(1),
  /** Short operator-facing label (e.g. "Cursor desktop") so a user can tell tokens apart to revoke. */
  label: z.string().min(1),
  createdAt: z.string().datetime(),
  /** Bumped on every verified use — operational visibility only, not part of the auth decision. */
  lastUsedAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
});
export type McpTokenRecord = z.infer<typeof McpTokenRecordSchema>;

/** `issueMcpToken` input/output (dashboard-facing tRPC procedure). */
export const IssueMcpTokenInputSchema = z.object({
  userId: z.string().min(1),
  label: z.string().min(1),
});
export type IssueMcpTokenInput = z.infer<typeof IssueMcpTokenInputSchema>;

export const IssueMcpTokenResultSchema = z.object({
  /** The plaintext token — returned ONCE, at issuance, never retrievable again. */
  token: z.string().min(1),
  tokenHash: z.string().min(1),
  userId: z.string().min(1),
  label: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type IssueMcpTokenResult = z.infer<typeof IssueMcpTokenResultSchema>;

/** DTO for listing a user's own issued tokens — never includes the plaintext token or its hash. */
export const McpTokenSummarySchema = z.object({
  label: z.string().min(1),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
});
export type McpTokenSummary = z.infer<typeof McpTokenSummarySchema>;

export class McpTokenInvalidError extends Error {
  constructor() {
    super('MCP token is invalid, revoked, or unknown.');
    this.name = 'McpTokenInvalidError';
  }
}
