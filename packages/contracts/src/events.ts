import { z } from 'zod';

import {
  eventIdSchema,
  outboxItemIdSchema,
  sha256Schema,
  tenantIdSchema,
  timestampSchema,
  versionSchema,
} from './ids.js';

export const domainEventSchema = z
  .object({
    schemaVersion: z.literal('1'),
    eventId: eventIdSchema,
    tenantId: tenantIdSchema,
    eventType: z.string().min(1),
    aggregateType: z.string().min(1),
    aggregateId: z.string().min(1),
    aggregateVersion: z.number().int().positive(),
    payloadHash: sha256Schema,
    payloadRef: z.string().min(1),
    occurredAt: timestampSchema,
    correlationId: z.string().min(1),
    causationId: z.string().min(1).optional(),
  })
  .strict();

export const eventOutboxRecordSchema = z
  .object({
    schemaVersion: z.literal('1'),
    outboxItemId: outboxItemIdSchema,
    tenantId: tenantIdSchema,
    event: domainEventSchema,
    busName: z.string().min(1),
    eventContractVersion: versionSchema,
    status: z.enum(['pending', 'claimed', 'published', 'failed']),
    claimOwner: z.string().min(1).optional(),
    claimExpiresAt: timestampSchema.optional(),
    attemptCount: z.number().int().nonnegative(),
    nextAttemptAt: timestampSchema.optional(),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.tenantId !== record.event.tenantId) {
      context.addIssue({
        code: 'custom',
        message: 'outbox record and nested event tenant must align',
        path: ['event', 'tenantId'],
      });
    }
  });

export const feedbackAtomicWriteSchema = z
  .object({
    transactionVersion: z.literal('1'),
    immutableFactId: eventIdSchema,
    eventOutboxItem: eventOutboxRecordSchema,
    conditionHash: sha256Schema,
  })
  .strict();

export type DomainEvent = z.infer<typeof domainEventSchema>;
export type EventOutboxRecord = z.infer<typeof eventOutboxRecordSchema>;
export type FeedbackAtomicWrite = z.infer<typeof feedbackAtomicWriteSchema>;
