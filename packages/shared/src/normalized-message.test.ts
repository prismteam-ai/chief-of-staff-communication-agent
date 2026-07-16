import { describe, expect, it } from 'vitest';
import { NormalizedMessageSchema, CURRENT_SCHEMA_VERSION, commIdFor } from './normalized-message.js';

describe('commIdFor', () => {
  it('derives a stable id from channel + externalId', () => {
    expect(commIdFor('gmail', 'msg-1')).toBe('gmail#msg-1');
  });

  it('is deterministic — same inputs, same id', () => {
    expect(commIdFor('sms', 'SM123')).toBe(commIdFor('sms', 'SM123'));
  });

  it('distinguishes different channels sharing an external id', () => {
    expect(commIdFor('gmail', 'x')).not.toBe(commIdFor('sms', 'x'));
  });
});

function validFixture() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    channelType: 'gmail',
    accountId: 'acct_demo-user-1',
    externalId: '18c9f2a1b3e4d5f6',
    threadKey: 'thread_18c9f2a1b3e4d5f6',
    participants: [
      { id: 'exec@example.com', displayName: 'Exec User', role: 'to' },
      { id: 'sender@example.com', displayName: 'Sender', role: 'from' },
    ],
    ts: '2026-07-15T12:00:00.000Z',
    body: 'Hello, can we meet Thursday?',
    attachments: [],
  };
}

describe('NormalizedMessageSchema', () => {
  it('accepts a valid fixture', () => {
    const result = NormalizedMessageSchema.safeParse(validFixture());
    expect(result.success).toBe(true);
  });

  it('accepts a valid fixture with attachments', () => {
    const fixture = validFixture();
    const result = NormalizedMessageSchema.safeParse({
      ...fixture,
      attachments: [
        {
          id: 'att_1',
          filename: 'invoice.pdf',
          contentType: 'application/pdf',
          sizeBytes: 12345,
          s3Key: 'raw/acct_demo-user-1/thread_18c9f2a1b3e4d5f6/att_1.pdf',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it.each(['channelType', 'accountId', 'externalId', 'threadKey', 'participants', 'ts', 'body'])(
    'rejects a fixture missing required field %s',
    (field) => {
      const fixture = validFixture() as Record<string, unknown>;
      delete fixture[field];
      const result = NormalizedMessageSchema.safeParse(fixture);
      expect(result.success).toBe(false);
    },
  );

  it('rejects an unknown channelType', () => {
    const result = NormalizedMessageSchema.safeParse({
      ...validFixture(),
      channelType: 'carrier-pigeon',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO ts', () => {
    const result = NormalizedMessageSchema.safeParse({
      ...validFixture(),
      ts: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty externalId', () => {
    const result = NormalizedMessageSchema.safeParse({
      ...validFixture(),
      externalId: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a participant with a wrong-typed field', () => {
    const fixture = validFixture();
    const result = NormalizedMessageSchema.safeParse({
      ...fixture,
      participants: [{ id: 42, displayName: 'Bad', role: 'from' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an attachment missing s3Key', () => {
    const fixture = validFixture();
    const result = NormalizedMessageSchema.safeParse({
      ...fixture,
      attachments: [
        { id: 'att_1', filename: 'x.pdf', contentType: 'application/pdf', sizeBytes: 1 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('defaults schemaVersion when omitted, preserving additive-field forward compatibility', () => {
    const fixture = validFixture() as Record<string, unknown>;
    delete fixture.schemaVersion;
    const result = NormalizedMessageSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    }
  });

  it('ignores unknown additive fields instead of failing (forward-compatible additive policy)', () => {
    const result = NormalizedMessageSchema.safeParse({
      ...validFixture(),
      someFutureField: 'from a newer producer',
    });
    expect(result.success).toBe(true);
  });
});
