import { createHash, timingSafeEqual } from 'node:crypto';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { DashboardLoginInvalidError, type DashboardLoginResult } from '@chief-of-staff/shared';
import type { logger as LoggerType, metrics as MetricsType } from '../context.js';
import type { McpAuthService } from './mcp-auth-service.js';

/**
 * Demo-credential login gate (Task 8.5, brief constraint 2: "Keep it SIMPLE but REAL — the point
 * is the server issues the token after verifying a credential the client couldn't forge, not a
 * full identity provider"). This closes the actual gap the task targets: the dashboard used to
 * send a plain, client-supplied `userId` on every tRPC call with nothing behind it — anyone typing
 * `userId: "demo-alex"` could act as that user. `login` requires the caller to present a
 * credential the server verifies BEFORE minting a token, and every dashboard call after that
 * derives `userId` from the verified token (`dashboardAuthedMiddleware`), never from client input.
 *
 * Deliberately NOT a full identity provider: `credentials` is a short operator-provisioned list
 * (one demo user is enough to prove the mechanism — see the class doc comment on why this is
 * sufficient for the brief). Token minting itself is 100% reused from Task 11
 * (`McpAuthService.issue` — same table, same hash-only storage, same `verify` path everything else
 * in this codebase already trusts): this service adds NO new auth machinery, only a credential
 * check gating the SAME mint operation.
 */

export function hashCredential(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** One operator-provisioned demo identity: `username`/`password` map to exactly one `userId`.
 * `passwordHash` is the SHA-256 digest of the plaintext password — never the password itself (same
 * "never persist/compare the secret directly" discipline `hashToken` uses for MCP tokens). */
export interface DashboardCredential {
  username: string;
  passwordHash: string;
  userId: string;
}

export interface DashboardLoginServiceDeps {
  authService: Pick<McpAuthService, 'issue'>;
  /** Operator-provisioned demo credentials — loaded from Secrets Manager
   * (`dashboard-credentials.ts#loadDashboardCredentials`), never a code literal. A function (not a
   * static array) so the router can pass a fresh Secrets Manager read per call without every test
   * needing to fake async plumbing; production wires this to a call that itself caches (see that
   * module's doc comment) so this is cheap on a warm container. Resolves to `[]` when the secret
   * isn't provisioned for this deploy; every login attempt then fails closed (see `login` below)
   * rather than crashing. */
  loadCredentials: () => Promise<DashboardCredential[]>;
  log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
  metricsClient: Pick<typeof MetricsType, 'addMetric'>;
}

const LOGIN_TOKEN_LABEL = 'dashboard session';

export class DashboardLoginService {
  private readonly authService: Pick<McpAuthService, 'issue'>;
  private readonly loadCredentials: () => Promise<DashboardCredential[]>;
  private readonly log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
  private readonly metricsClient: Pick<typeof MetricsType, 'addMetric'>;

  constructor(deps: DashboardLoginServiceDeps) {
    this.authService = deps.authService;
    this.loadCredentials = deps.loadCredentials;
    this.log = deps.log;
    this.metricsClient = deps.metricsClient;
  }

  /**
   * Verifies `username`/`password` against the operator-provisioned demo credential list, then
   * mints a session token via the SAME `McpAuthService.issue` Task 11 uses for MCP tokens. Fails
   * closed with the SAME `DashboardLoginInvalidError` for every rejection reason (unknown
   * username, wrong password, no credentials provisioned) — no distinguishing signal that would
   * help an attacker enumerate valid usernames, same posture `McpAuthService.verify` uses for
   * token rejection.
   */
  async login(input: { username: string; password: string }): Promise<DashboardLoginResult> {
    const candidateHash = hashCredential(input.password);
    const credentials = await this.loadCredentials();
    const match = credentials.find((c) => c.username === input.username);

    if (!match || !constantTimeHashEqual(match.passwordHash, candidateHash)) {
      this.metricsClient.addMetric('DashboardAuthFailed', MetricUnit.Count, 1);
      this.log.warn('Dashboard login failed', { reason: match ? 'bad_password' : 'unknown_user' });
      throw new DashboardLoginInvalidError();
    }

    const issued = await this.authService.issue({
      userId: match.userId,
      label: LOGIN_TOKEN_LABEL,
    });

    this.metricsClient.addMetric('SessionTokenIssued', MetricUnit.Count, 1);
    this.log.info('Dashboard login succeeded', { userId: match.userId });

    return { token: issued.token, userId: issued.userId };
  }
}

/** Both hashes are fixed-length SHA-256 hex digests (64 chars) — safe to compare directly with
 * `timingSafeEqual` without a length-guard branch (unlike `twilio-client.ts`'s HMAC compare, which
 * must guard variable-length input first). */
function constantTimeHashEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
