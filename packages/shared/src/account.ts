import { z } from 'zod';
import { CHANNEL_TYPES } from './normalized-message.js';

/**
 * Account model (design.md §3, §10): every message, token, and query carries an `account_id`, and
 * every read path enforces per-user account boundaries. An `Account` is the internal record that
 * ties a connected channel identity (a Gmail mailbox, a Twilio number, …) to the owning user and to
 * the Secrets Manager entry holding its credential — never the credential itself (design.md §10:
 * "no secret in code, logs, or the client bundle").
 */
export const AccountSchema = z.object({
  accountId: z.string().min(1),
  /** Owning user — the basis for every permission check in `permissions.ts`. */
  userId: z.string().min(1),
  channelType: z.enum(CHANNEL_TYPES),
  displayName: z.string().min(1),
  /** ARN reference only; the credential itself lives exclusively in Secrets Manager. */
  credentialSecretArn: z.string().min(1),
  createdAt: z.string().datetime(),
});

export type Account = z.infer<typeof AccountSchema>;

/**
 * Minimal ownership lookup the permission guard needs: `accountId -> owning userId`. Real callers
 * (Task 6+) back this with a DynamoDB read of the accounts table; tests back it with a plain object
 * so the guard itself stays testable without AWS (design.md §10, brief constraint 3).
 */
export type AccountOwnershipMap = Record<string, string>;
