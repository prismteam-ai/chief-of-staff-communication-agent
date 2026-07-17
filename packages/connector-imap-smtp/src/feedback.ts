import { createHash } from 'node:crypto';

import {
  feedbackParseResultSchema,
  type FeedbackContext,
  type FeedbackParseResult,
} from '@chief/contracts/approval';
import type { VerifiedProviderEvent } from '@chief/contracts/connectors';
import { keyedDigestValueSchema } from '@chief/contracts/ids';

import { parseRfc3464DeliveryStatus } from './dsn.js';

export const imapSmtpFeedbackCapabilities = Object.freeze({
  dsnDelivery: 'provider_dependent' as const,
  dsnBounce: 'provider_dependent' as const,
  complaint: 'unknown' as const,
  unsubscribe: 'unknown' as const,
  optOut: 'unknown' as const,
  reconsent: 'unknown' as const,
  consentWindow: 'unknown' as const,
});

export function normalizeDsnFeedback(input: {
  readonly raw: Uint8Array;
  readonly event: VerifiedProviderEvent;
  readonly context: FeedbackContext;
  readonly providerTimestamp: string;
  readonly idempotencyDigest: string;
}): FeedbackParseResult {
  const rawPayloadDigest = createHash('sha256').update(input.raw).digest('hex');
  if (rawPayloadDigest !== input.event.rawPayloadDigest) {
    return { kind: 'invalid', reason: 'dsn_raw_payload_digest_mismatch' };
  }
  let dsn: ReturnType<typeof parseRfc3464DeliveryStatus>;
  try {
    dsn = parseRfc3464DeliveryStatus(Buffer.from(input.raw).toString('utf8'));
  } catch {
    return { kind: 'unsupported', reason: 'not_rfc3464_delivery_status' };
  }
  if (dsn.feedbackKind === 'unsupported') {
    return { kind: 'unsupported', reason: 'dsn_action_unsupported' };
  }
  const providerMessageId = Buffer.from(input.raw)
    .toString('utf8')
    .match(/^Message-ID:\s*(<[^<>\s]+@[^<>\s]+>)\s*$/imu)?.[1];
  return feedbackParseResultSchema.parse({
    kind: 'verified',
    fact: {
      schemaVersion: '1',
      tenantId: input.event.tenantId,
      feedbackFactId: `imap-dsn:${input.event.providerEventId}`,
      providerEventId: input.event.providerEventId,
      ...(providerMessageId === undefined ? {} : { providerMessageId }),
      ...(dsn.originalEnvelopeId === undefined
        ? {}
        : { providerCorrelation: dsn.originalEnvelopeId }),
      ...(input.context.knownOperationId === undefined
        ? {}
        : { operationId: input.context.knownOperationId }),
      ...(input.context.knownAttemptId === undefined
        ? {}
        : { attemptId: input.context.knownAttemptId }),
      feedbackKind: dsn.feedbackKind,
      providerTimestamp: input.providerTimestamp,
      rawEventRef: input.event.rawEventRef,
      rawPayloadDigest,
      connectorSnapshot: input.event.connectorSnapshot,
      idempotencyDigest: keyedDigestValueSchema.parse(input.idempotencyDigest),
    },
  });
}
