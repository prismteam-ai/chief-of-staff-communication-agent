import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { loadAccountRefreshToken } from './gmail-client.js';

const smMock = mockClient(SecretsManagerClient);

// The secret cache in gmail-client.ts is module-level (by design — it must survive across Lambda
// invocations on a warm container), so it is NOT reset between tests in this file. Each test below
// uses its own unique per-account secret id specifically to stay isolated from that shared cache
// rather than fighting it.
beforeEach(() => {
  smMock.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gmail-client secret caching', () => {
  it('hits Secrets Manager once for two calls to the same secret within the TTL', async () => {
    smMock.on(GetSecretValueCommand, { SecretId: 'cos/gmail-token-acct_ttl_hit' }).resolves({
      SecretString: JSON.stringify({ refresh_token: 'rt-1' }),
    });

    const first = await loadAccountRefreshToken('acct_ttl_hit');
    const second = await loadAccountRefreshToken('acct_ttl_hit');

    expect(first).toBe('rt-1');
    expect(second).toBe('rt-1');
    expect(smMock.commandCalls(GetSecretValueCommand, { SecretId: 'cos/gmail-token-acct_ttl_hit' })).toHaveLength(1);
  });

  it('re-fetches after the cache TTL expires', async () => {
    smMock.on(GetSecretValueCommand, { SecretId: 'cos/gmail-token-acct_ttl_expiry' }).resolves({
      SecretString: JSON.stringify({ refresh_token: 'rt-2' }),
    });

    await loadAccountRefreshToken('acct_ttl_expiry');
    vi.setSystemTime(new Date('2026-07-16T00:05:01.000Z')); // > 5 min maxAge
    await loadAccountRefreshToken('acct_ttl_expiry');

    expect(smMock.commandCalls(GetSecretValueCommand, { SecretId: 'cos/gmail-token-acct_ttl_expiry' })).toHaveLength(
      2,
    );
  });

  it('caches distinct secret ids independently (two different accounts)', async () => {
    smMock.on(GetSecretValueCommand, { SecretId: 'cos/gmail-token-acct_distinct_a' }).resolves({
      SecretString: JSON.stringify({ refresh_token: 'rt-a' }),
    });
    smMock.on(GetSecretValueCommand, { SecretId: 'cos/gmail-token-acct_distinct_b' }).resolves({
      SecretString: JSON.stringify({ refresh_token: 'rt-b' }),
    });

    await loadAccountRefreshToken('acct_distinct_a');
    await loadAccountRefreshToken('acct_distinct_b');
    await loadAccountRefreshToken('acct_distinct_a');
    await loadAccountRefreshToken('acct_distinct_b');

    expect(smMock.commandCalls(GetSecretValueCommand, { SecretId: 'cos/gmail-token-acct_distinct_a' })).toHaveLength(
      1,
    );
    expect(smMock.commandCalls(GetSecretValueCommand, { SecretId: 'cos/gmail-token-acct_distinct_b' })).toHaveLength(
      1,
    );
  });
});
