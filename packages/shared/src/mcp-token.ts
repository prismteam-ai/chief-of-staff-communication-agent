import { z } from 'zod';

/**
 * Per-user MCP token contract (Task 11, design.md §8: "calling the hosted API with a per-user
 * scoped token issued in the dashboard"). The Cursor MCP server has no AWS credentials — every
 * call it makes to the hosted tRPC API authenticates with an opaque bearer token instead of a
 * client-supplied `userId`. The token maps to exactly one `userId` server-side, so every
 * MCP-driven call is scoped by the SAME account-permission guard (`assertAccountAccess`) every
 * other read/write path already enforces (design.md §10) — a forged or another user's token can
 * never widen access, because the `userId` a procedure acts as comes from the verified token, not
 * from anything the caller asserts.
 *
 * ## Storage shape (`McpTokenRecord`)
 * Only the SHA-256 hash of the token is ever persisted (`tokenHash`, DynamoDB PK) — the same
 * "never the secret itself" discipline `Account.credentialSecretArn` uses for provider credentials
 * (design.md §10: "no secret in code, logs, or the client bundle"). The plaintext token is shown to
 * the user exactly once, at issuance time, then never persisted or logged anywhere again.
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
