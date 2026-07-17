import { describe, expect, it } from 'vitest';
import { AccountSchema } from './account.js';

describe('AccountSchema', () => {
  it('accepts a valid account record', () => {
    const result = AccountSchema.safeParse({
      accountId: 'acct_1',
      userId: 'user_a',
      channelType: 'gmail',
      displayName: 'exec@example.com',
      credentialSecretArn: 'arn:aws:secretsmanager:us-east-2:123456789012:secret:acct-1-abcdef',
      createdAt: '2026-07-15T12:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an account missing userId (every record must carry ownership)', () => {
    const result = AccountSchema.safeParse({
      accountId: 'acct_1',
      channelType: 'gmail',
      displayName: 'exec@example.com',
      credentialSecretArn: 'arn:aws:secretsmanager:us-east-2:123456789012:secret:acct-1-abcdef',
      createdAt: '2026-07-15T12:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown channelType', () => {
    const result = AccountSchema.safeParse({
      accountId: 'acct_1',
      userId: 'user_a',
      channelType: 'carrier-pigeon',
      displayName: 'exec@example.com',
      credentialSecretArn: 'arn:aws:secretsmanager:us-east-2:123456789012:secret:acct-1-abcdef',
      createdAt: '2026-07-15T12:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});
