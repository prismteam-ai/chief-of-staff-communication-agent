import { createHash } from 'node:crypto';

import { feedbackContextSchema } from '@chief/contracts/approval';
import { verifiedProviderEventSchema } from '@chief/contracts/connectors';
import { describe, expect, it } from 'vitest';

import { parseRfc3464DeliveryStatus } from './dsn.js';
import { normalizeDsnFeedback } from './feedback.js';
import { parseMimeMessage } from './mime.js';
import {
  RFC3464_BOUNCE,
  RFC5322_REPLY_WITH_ATTACHMENT,
} from './provider-fixtures.js';

describe('byte-exact RFC message fixtures', () => {
  it('normalizes MIME, attachment bytes, and reply headers deterministically', async () => {
    const first = await parseMimeMessage(RFC5322_REPLY_WITH_ATTACHMENT);
    const second = await parseMimeMessage(RFC5322_REPLY_WITH_ATTACHMENT);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      messageId: '<reply-002@example.test>',
      inReplyTo: '<root-001@example.test>',
      references: ['<root-001@example.test>'],
      threadRootMessageId: '<root-001@example.test>',
    });
    expect(first.attachments).toHaveLength(1);
    expect(
      Buffer.from(first.attachments[0]?.content ?? []).toString('utf8'),
    ).toBe('byte-exact-evidence\n');
  });

  it('parses RFC 3464 bounce facts without promoting fixture evidence to live proof', () => {
    const dsn = parseRfc3464DeliveryStatus(
      Buffer.from(RFC3464_BOUNCE).toString('utf8'),
    );
    expect(dsn).toMatchObject({
      originalEnvelopeId: 'operation-a',
      feedbackKind: 'bounced',
      recipients: [
        {
          finalRecipient: 'recipient@example.test',
          action: 'failed',
          status: '5.1.1',
        },
      ],
    });
  });

  it('normalizes a digest-bound DSN into a canonical feedback fact', () => {
    const snapshot = {
      connectorId: 'imap-smtp',
      descriptorVersion: '1.0.0-protocol',
      accountId: 'account-a',
      capabilitySnapshotHash: 'a'.repeat(64),
      runtimeMode: 'fixture' as const,
      selectionState: 'fallback_candidate' as const,
    };
    const result = normalizeDsnFeedback({
      raw: RFC3464_BOUNCE,
      event: verifiedProviderEventSchema.parse({
        schemaVersion: '1',
        tenantId: 'tenant-a',
        accountId: 'account-a',
        providerEventId: 'dsn-event-a',
        rawEventRef: 's3://fixture/dsn-event-a',
        rawPayloadDigest: createHash('sha256')
          .update(RFC3464_BOUNCE)
          .digest('hex'),
        verifiedAt: '2026-07-17T12:01:00.000Z',
        verificationMethod: 'imap-strict-tls-fetch-v1',
        connectorSnapshot: snapshot,
      }),
      context: feedbackContextSchema.parse({
        tenantId: 'tenant-a',
        account: {
          tenantId: 'tenant-a',
          accountId: 'account-a',
          expectedStateVersion: 1,
        },
        connectorSnapshot: snapshot,
        knownOperationId: 'operation-a',
        knownAttemptId: 'attempt-a',
      }),
      providerTimestamp: '2026-07-17T12:01:00.000Z',
      idempotencyDigest: 'h1_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(result).toMatchObject({
      kind: 'verified',
      fact: {
        feedbackKind: 'bounced',
        providerCorrelation: 'operation-a',
        operationId: 'operation-a',
        attemptId: 'attempt-a',
      },
    });
  });
});
