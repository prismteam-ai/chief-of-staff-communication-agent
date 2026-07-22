import { z } from 'zod';

export const foundationCapabilities = [
  'connectors',
  'oauth',
  'rag',
  'actions',
  'agents',
] as const;

export const healthResponseSchema = z
  .object({
    service: z.string().min(1),
    status: z.literal('ok'),
    timestamp: z.iso.datetime(),
    foundationOnly: z.literal(true),
  })
  .strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const productHealthResponseSchema = healthResponseSchema.extend({
  foundationOnly: z.literal(false),
});

export type ProductHealthResponse = z.infer<typeof productHealthResponseSchema>;

export const foundationOnlyErrorSchema = z
  .object({
    code: z.literal('MCP_FOUNDATION_ONLY'),
    message: z.string().min(1),
    foundationOnly: z.literal(true),
  })
  .strict();

export type FoundationOnlyError = z.infer<typeof foundationOnlyErrorSchema>;

export const workerFoundationResultSchema = z
  .object({
    worker: z.enum(['ingestion-worker', 'execution-worker']),
    status: z.literal('foundation-ready'),
    externalEffects: z.literal('disabled'),
  })
  .strict();

export type WorkerFoundationResult = z.infer<
  typeof workerFoundationResultSchema
>;

export function createHealthResponse(service: string): HealthResponse {
  return healthResponseSchema.parse({
    service,
    status: 'ok',
    timestamp: new Date().toISOString(),
    foundationOnly: true,
  });
}

export function createProductHealthResponse(
  service: string,
): ProductHealthResponse {
  return productHealthResponseSchema.parse({
    service,
    status: 'ok',
    timestamp: new Date().toISOString(),
    foundationOnly: false,
  });
}
