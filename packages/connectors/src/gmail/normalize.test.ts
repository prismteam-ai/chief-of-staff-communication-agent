import { describe, expect, it } from 'vitest';
import { NormalizedMessageSchema } from '@chief-of-staff/shared';
import { normalizeGmailMessage, type GmailMessage } from './normalize.js';
import simpleMessage from './fixtures/simple-message.json' with { type: 'json' };
import threadOriginal from './fixtures/thread-original.json' with { type: 'json' };
import threadReply from './fixtures/thread-reply.json' with { type: 'json' };
import messageWithAttachment from './fixtures/message-with-attachment.json' with { type: 'json' };

const ACCOUNT_ID = 'acct_demo-alex-gmail';

describe('normalizeGmailMessage', () => {
  it('normalizes a simple inbound message into a schema-valid NormalizedMessage', () => {
    const result = normalizeGmailMessage(simpleMessage as GmailMessage, ACCOUNT_ID);

    expect(NormalizedMessageSchema.safeParse(result).success).toBe(true);
    expect(result.channelType).toBe('gmail');
    expect(result.accountId).toBe(ACCOUNT_ID);
    expect(result.externalId).toBe('18f2a1c3d4e5f601');
    expect(result.threadKey).toBe('18f2a1c3d4e5f601');
    expect(result.attachments).toEqual([]);
  });

  it('prefers text/plain body over text/html when both are present', () => {
    const result = normalizeGmailMessage(simpleMessage as GmailMessage, ACCOUNT_ID);

    expect(result.body).toContain('Just checking in on the Q3 budget review');
    expect(result.body).not.toContain('<div>');
  });

  it('derives participants with roles from From/To headers', () => {
    const result = normalizeGmailMessage(simpleMessage as GmailMessage, ACCOUNT_ID);

    const from = result.participants.find((p) => p.role === 'from');
    const to = result.participants.find((p) => p.role === 'to');

    expect(from).toEqual({
      id: 'priya.natarajan@northwind-consulting.com',
      displayName: 'Priya Natarajan',
      role: 'from',
    });
    expect(to).toEqual({
      id: 'demoalex775@gmail.com',
      displayName: 'Alex Rivera',
      role: 'to',
    });
  });

  it('resolves the timestamp from internalDate as an ISO-8601 string', () => {
    const result = normalizeGmailMessage(simpleMessage as GmailMessage, ACCOUNT_ID);

    expect(result.ts).toBe(new Date(1752577200000).toISOString());
  });

  it('includes cc participants', () => {
    const result = normalizeGmailMessage(threadOriginal as GmailMessage, ACCOUNT_ID);

    const cc = result.participants.find((p) => p.role === 'cc');
    expect(cc).toEqual({ id: 'legal@meridian-partners.io', displayName: 'Legal', role: 'cc' });
  });

  it('assigns the same threadKey to an original message and its reply', () => {
    const original = normalizeGmailMessage(threadOriginal as GmailMessage, ACCOUNT_ID);
    const reply = normalizeGmailMessage(threadReply as GmailMessage, ACCOUNT_ID);

    expect(original.threadKey).toBe('18f2b7e0a1c2d301');
    expect(reply.threadKey).toBe('18f2b7e0a1c2d301');
    expect(original.threadKey).toBe(reply.threadKey);
    // But distinct messages within the thread keep distinct externalIds.
    expect(original.externalId).not.toBe(reply.externalId);
  });

  it('orders the reply after the original by timestamp', () => {
    const original = normalizeGmailMessage(threadOriginal as GmailMessage, ACCOUNT_ID);
    const reply = normalizeGmailMessage(threadReply as GmailMessage, ACCOUNT_ID);

    expect(new Date(reply.ts).getTime()).toBeGreaterThan(new Date(original.ts).getTime());
  });

  it('extracts an attachment descriptor with filename, contentType, and sizeBytes', () => {
    const result = normalizeGmailMessage(messageWithAttachment as GmailMessage, ACCOUNT_ID);

    expect(result.attachments).toHaveLength(1);
    const [attachment] = result.attachments;
    expect(attachment).toMatchObject({
      filename: 'vendor-agreement-signed.pdf',
      contentType: 'application/pdf',
      sizeBytes: 184320,
    });
    expect(attachment?.id).toContain('attachment-001-vendor-agreement');
    expect(attachment?.s3Key).toContain('18f2c4a9e5f60703');
  });

  it('still extracts body text/plain when the message also carries an attachment', () => {
    const result = normalizeGmailMessage(messageWithAttachment as GmailMessage, ACCOUNT_ID);

    expect(result.body).toContain('Please find attached the signed vendor agreement');
  });

  it('throws when the message has no id', () => {
    expect(() => normalizeGmailMessage({ threadId: 't1' }, ACCOUNT_ID)).toThrow();
  });

  it('throws when the message has no threadId', () => {
    expect(() => normalizeGmailMessage({ id: 'm1' }, ACCOUNT_ID)).toThrow();
  });

  it('throws when the message has no From/To/Cc/Bcc headers', () => {
    expect(() =>
      normalizeGmailMessage(
        { id: 'm1', threadId: 't1', internalDate: '1700000000000' },
        ACCOUNT_ID,
      ),
    ).toThrow();
  });
});
