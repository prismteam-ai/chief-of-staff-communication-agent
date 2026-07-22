import { z } from 'zod';

export const domainErrorCodeSchema = z.enum([
  'CROSS_TENANT_ACCESS',
  'STALE_REVISION',
  'STALE_EPOCH',
  'INVALID_TRANSITION',
  'DUPLICATE_EFFECT',
  'UNSAFE_RETRY',
  'APPROVAL_REQUIRED',
  'APPROVAL_INVALID',
  'CONTACT_POLICY_BLOCKED',
  'CORRELATION_REQUIRED',
  'INDEX_REFRESH_REQUIRED',
]);

export const domainErrorSchema = z
  .object({
    code: domainErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    details: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type DomainErrorCode = z.infer<typeof domainErrorCodeSchema>;
export type DomainError = z.infer<typeof domainErrorSchema>;
