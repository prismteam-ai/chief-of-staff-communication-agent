import { KeyCodec } from '@chief/persistence-dynamodb';

import { createAwsProductionIngestionHandler } from './aws-composition.js';
import {
  DeterministicRetrievalMutationSink,
  InMemoryIngestionStore,
  RecordingRetrievalIndex,
} from './memory-store.js';
import { CanonicalIngestionPipeline } from './pipeline.js';
import type { SqsBatchResponse, SqsEvent } from './production-ingress.js';
import { createIngestionHandler, type IngestionHandler } from './service.js';

/**
 * Credentialless fixture runtime for deterministic local/demo-shaped Lambda
 * invocations. Production composition uses createIngestionHandler with the
 * Dynamo-backed store, account key material, and bounded retrieval adapter.
 */
export function createFixtureIngestionHandler(): IngestionHandler {
  const store = new InMemoryIngestionStore();
  const keyCodec = new KeyCodec({
    current: {
      version: 'fixture_v1',
      secret: new Uint8Array(32).fill(7),
    },
  });
  return createIngestionHandler(
    new CanonicalIngestionPipeline({
      store,
      keyCodec,
      retrievalSink: new DeterministicRetrievalMutationSink(),
      retrievalRegistrar: new RecordingRetrievalIndex(),
    }),
  );
}

let productionHandler:
  Promise<(event: SqsEvent) => Promise<SqsBatchResponse>> | undefined;

/**
 * Deployment entry point. It has no fixture fallback: missing configuration,
 * digest material, or AWS access rejects the invocation before processing.
 */
export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  productionHandler ??= createAwsProductionIngestionHandler(process.env);
  return (await productionHandler)(event);
}

export * from './authored-segment.js';
export * from './aws-composition.js';
export * from './dynamo-store.js';
export * from './memory-store.js';
export * from './pipeline.js';
export * from './production-ingress.js';
export * from './runtime-config.js';
export * from './service.js';
export type * from './types.js';
