import { describe, expect, it } from 'vitest';

import { normalizeGmailMessage } from './normalization.js';
import { GMAIL_PROVIDER_MESSAGE_FIXTURE } from './provider-fixtures.js';

describe('Gmail message normalization', () => {
  it('normalizes bodies, attachments, participants, and reply headers', () => {
    const message = normalizeGmailMessage(GMAIL_PROVIDER_MESSAGE_FIXTURE);
    expect(message).toMatchObject({
      providerMessageId: 'provider-message-a',
      providerThreadId: 'provider-thread-a',
      from: 'Alex Example <alex@example.invalid>',
      to: ['Chief <chief@example.invalid>'],
      cc: ['Ops <ops@example.invalid>'],
      subject: 'Quarterly plan',
      textBody: 'Hello from the provider-shaped Gmail fixture.',
      htmlBody: '<p>Hello from the provider-shaped Gmail fixture.</p>',
      attachments: [
        {
          attachmentId: 'attachment-a',
          filename: 'plan.pdf',
          mimeType: 'application/pdf',
          size: 321,
        },
      ],
      reply: {
        messageId: '<provider-message-a@example.invalid>',
        inReplyTo: '<provider-message-prior@example.invalid>',
        references: [
          '<provider-message-root@example.invalid>',
          '<provider-message-prior@example.invalid>',
        ],
      },
    });
  });

  it('rejects a message without a trustworthy Gmail internalDate', () => {
    expect(() =>
      normalizeGmailMessage({
        ...GMAIL_PROVIDER_MESSAGE_FIXTURE,
        internalDate: undefined,
      }),
    ).toThrow('GMAIL_MESSAGE_INTERNAL_DATE_REQUIRED');
  });
});
