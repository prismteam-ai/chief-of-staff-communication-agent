import { describe, expect, it, vi } from 'vitest';
import { McpTokenInvalidError, type McpTokenRecord } from '@chief-of-staff/shared';
import { McpAuthService, hashToken } from './mcp-auth-service.js';
import type { McpTokensRepo } from '../repos/mcp-tokens-repo.js';

/**
 * Coverage for the MCP token issuance/verification service (Task 11, brief constraint 7): issued
 * token maps to the right userId, account-scopes calls, and a forged/unknown/revoked token is
 * rejected — the security property the LIVE proof step re-verifies against the deployed API.
 */

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeMetrics() {
  return { addMetric: vi.fn() };
}

function fakeTokensRepo(
  seed: McpTokenRecord[] = [],
): McpTokensRepo & { store: Map<string, McpTokenRecord> } {
  const store = new Map(seed.map((r) => [r.tokenHash, r]));
  return {
    store,
    async put(record) {
      if (store.has(record.tokenHash)) {
        throw new Error('ConditionalCheckFailedException');
      }
      store.set(record.tokenHash, record);
    },
    async getByHash(tokenHash) {
      return store.get(tokenHash);
    },
    async touchLastUsed(tokenHash, at) {
      const existing = store.get(tokenHash);
      if (existing) store.set(tokenHash, { ...existing, lastUsedAt: at });
    },
  };
}

describe('McpAuthService.issue', () => {
  it('mints a token, persists only its hash, and returns the plaintext once', async () => {
    const tokensRepo = fakeTokensRepo();
    const service = new McpAuthService({
      tokensRepo,
      log: fakeLogger(),
      metricsClient: fakeMetrics(),
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    });

    const issued = await service.issue({ userId: 'demo-alex', label: 'Cursor desktop' });

    expect(issued.token).toMatch(/^cos_mcp_[0-9a-f]{64}$/);
    expect(issued.tokenHash).toBe(hashToken(issued.token));
    expect(issued.userId).toBe('demo-alex');

    // The stored record has the hash, never the plaintext token.
    const stored = tokensRepo.store.get(issued.tokenHash);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(issued.token);
  });

  it('mints distinct tokens on repeated calls', async () => {
    const service = new McpAuthService({
      tokensRepo: fakeTokensRepo(),
      log: fakeLogger(),
      metricsClient: fakeMetrics(),
    });

    const a = await service.issue({ userId: 'demo-alex', label: 'one' });
    const b = await service.issue({ userId: 'demo-alex', label: 'two' });

    expect(a.token).not.toBe(b.token);
  });
});

describe('McpAuthService.verify', () => {
  it('resolves a valid token to the userId it was issued for', async () => {
    const tokensRepo = fakeTokensRepo();
    const service = new McpAuthService({
      tokensRepo,
      log: fakeLogger(),
      metricsClient: fakeMetrics(),
    });
    const issued = await service.issue({ userId: 'demo-alex', label: 'Cursor desktop' });

    const userId = await service.verify(issued.token);

    expect(userId).toBe('demo-alex');
  });

  it('SECURITY: rejects a forged token that was never issued', async () => {
    const service = new McpAuthService({
      tokensRepo: fakeTokensRepo(),
      log: fakeLogger(),
      metricsClient: fakeMetrics(),
    });

    await expect(service.verify('cos_mcp_' + 'f'.repeat(64))).rejects.toBeInstanceOf(
      McpTokenInvalidError,
    );
  });

  it('SECURITY: rejects a revoked token', async () => {
    const tokensRepo = fakeTokensRepo();
    const service = new McpAuthService({
      tokensRepo,
      log: fakeLogger(),
      metricsClient: fakeMetrics(),
    });
    const issued = await service.issue({ userId: 'demo-alex', label: 'Cursor desktop' });
    const stored = tokensRepo.store.get(issued.tokenHash)!;
    tokensRepo.store.set(issued.tokenHash, { ...stored, revokedAt: '2026-07-16T01:00:00.000Z' });

    await expect(service.verify(issued.token)).rejects.toBeInstanceOf(McpTokenInvalidError);
  });

  it(
    'SECURITY: user A token never resolves to user B — two tokens for two users stay ' +
      'independently scoped',
    async () => {
      const tokensRepo = fakeTokensRepo();
      const service = new McpAuthService({
        tokensRepo,
        log: fakeLogger(),
        metricsClient: fakeMetrics(),
      });
      const alexToken = await service.issue({ userId: 'demo-alex', label: 'Cursor' });
      const blakeToken = await service.issue({ userId: 'demo-blake', label: 'Cursor' });

      await expect(service.verify(alexToken.token)).resolves.toBe('demo-alex');
      await expect(service.verify(blakeToken.token)).resolves.toBe('demo-blake');
      // Tampering with one character of a real token must not resolve to any user.
      const tampered = alexToken.token.slice(0, -1) + (alexToken.token.endsWith('0') ? '1' : '0');
      await expect(service.verify(tampered)).rejects.toBeInstanceOf(McpTokenInvalidError);
    },
  );

  it('records lastUsedAt on successful verification without failing the call if it errors', async () => {
    const tokensRepo = fakeTokensRepo();
    tokensRepo.touchLastUsed = async () => {
      throw new Error('transient dynamo error');
    };
    const service = new McpAuthService({
      tokensRepo,
      log: fakeLogger(),
      metricsClient: fakeMetrics(),
    });
    const issued = await service.issue({ userId: 'demo-alex', label: 'Cursor' });

    await expect(service.verify(issued.token)).resolves.toBe('demo-alex');
  });
});
