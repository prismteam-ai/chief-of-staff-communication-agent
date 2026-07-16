import { randomBytes, createHash } from 'node:crypto';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { McpTokenInvalidError, type McpTokenSummary } from '@chief-of-staff/shared';
import type { logger as LoggerType, metrics as MetricsType } from '../context.js';
import type { McpTokensRepo } from '../repos/mcp-tokens-repo.js';

/**
 * Per-user MCP token issuance + verification (Task 11, design.md §8, brief constraint 3). Owns the
 * ONLY two operations that touch the token table: `issue` (dashboard action — mints a token for a
 * given `userId`) and `verify` (every MCP-driven tRPC call — resolves a bearer token to the
 * `userId` it was issued for). `verify` is the security-critical path: a forged token, an unknown
 * hash, or a revoked token must all fail closed with the SAME `McpTokenInvalidError` (no
 * distinguishing signal that would help an attacker enumerate valid tokens), and the resolved
 * `userId` is the ONLY `userId` any MCP-authenticated call is allowed to act as — never a
 * caller-supplied one (brief constraint 3: "NEVER trust a client-supplied userId when a token is
 * present").
 *
 * Framework-free — `routers/mcp.ts` is a thin tRPC adapter over this class, same separation
 * `ApprovalService`/`AsanaService` already use.
 */

const TOKEN_BYTES = 32; // 256 bits of entropy — encoded as a 64-char hex string below.
const TOKEN_PREFIX = 'cos_mcp_';

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface McpAuthServiceDeps {
  tokensRepo: McpTokensRepo;
  log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
  metricsClient: Pick<typeof MetricsType, 'addMetric'>;
  now?: () => Date;
  /** Injectable token generator for deterministic tests; defaults to `crypto.randomBytes`. */
  generateToken?: () => string;
}

export interface IssueTokenInput {
  userId: string;
  label: string;
}

export interface IssuedToken {
  token: string;
  tokenHash: string;
  userId: string;
  label: string;
  createdAt: string;
}

export class McpAuthService {
  private readonly tokensRepo: McpTokensRepo;
  private readonly log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
  private readonly metricsClient: Pick<typeof MetricsType, 'addMetric'>;
  private readonly now: () => Date;
  private readonly generateToken: () => string;

  constructor(deps: McpAuthServiceDeps) {
    this.tokensRepo = deps.tokensRepo;
    this.log = deps.log;
    this.metricsClient = deps.metricsClient;
    this.now = deps.now ?? (() => new Date());
    this.generateToken =
      deps.generateToken ?? (() => `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('hex')}`);
  }

  /** Mints a new token for `userId` (dashboard action, Task 8's token-issuance view). The plaintext
   * token is returned exactly once — only its hash is ever persisted. */
  async issue(input: IssueTokenInput): Promise<IssuedToken> {
    const token = this.generateToken();
    const tokenHash = hashToken(token);
    const createdAt = this.now().toISOString();

    await this.tokensRepo.put({
      tokenHash,
      userId: input.userId,
      label: input.label,
      createdAt,
    });

    this.metricsClient.addMetric('McpTokenIssued', MetricUnit.Count, 1);
    this.log.info('MCP token issued', { userId: input.userId, label: input.label });

    return { token, tokenHash, userId: input.userId, label: input.label, createdAt };
  }

  /**
   * Resolves a bearer token to the `userId` it was issued for. Throws `McpTokenInvalidError` for
   * every failure mode (unknown hash, revoked token) — the SAME error, deliberately, so a caller
   * probing for valid token shapes learns nothing from the failure mode (brief constraint 7:
   * "forged/expired token rejected").
   */
  async verify(token: string): Promise<string> {
    const tokenHash = hashToken(token);
    const record = await this.tokensRepo.getByHash(tokenHash);

    if (!record || record.revokedAt) {
      this.metricsClient.addMetric('McpAuthFailed', MetricUnit.Count, 1);
      this.log.warn('MCP token verification failed', { reason: record ? 'revoked' : 'unknown' });
      throw new McpTokenInvalidError();
    }

    // Best-effort bookkeeping, isolated: a failed lastUsedAt bump must never fail the call it is
    // being recorded for (same "already-succeeded outcome" isolation posture as
    // `feedBackStyleExemplarIsolated`/`appendTurnIsolated` elsewhere in this codebase).
    try {
      await this.tokensRepo.touchLastUsed(tokenHash, this.now().toISOString());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('Failed to record MCP token last-used timestamp — auth still succeeded', {
        error: message,
      });
    }

    return record.userId;
  }
}

/** Strips storage internals down to the DTO the dashboard's token list may safely render. */
export function toMcpTokenSummary(record: {
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}): McpTokenSummary {
  return {
    label: record.label,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  };
}
