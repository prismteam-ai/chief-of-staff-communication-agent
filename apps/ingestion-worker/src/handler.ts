import { KeyCodec } from '@chief/persistence-dynamodb';
import { createObservability } from '@chief/observability';

import {
  DeterministicRetrievalMutationSink,
  InMemoryIngestionStore,
  RecordingRetrievalIndex,
} from './memory-store.js';
import { CanonicalIngestionPipeline } from './pipeline.js';
import type { IngestionEvent, IngestionResult } from './types.js';

const observability = createObservability('chief-ingestion-worker');

export type IngestionHandler = (
  event: IngestionEvent,
) => Promise<IngestionResult>;

export function createIngestionHandler(
  pipeline: CanonicalIngestionPipeline,
): IngestionHandler {
  return async (event) => {
    const result = await pipeline.process(event);
    observability.logger.info('Canonical ingestion invocation complete', {
      invocationId: result.invocationId,
      status: result.status,
      received: result.received,
      processed: result.processed,
      quarantined: result.quarantined,
      projectionFailures: result.projectionFailures,
      projectionRecoveriesQueued: result.projectionRecoveriesQueued,
      externalProviderCalls: result.externalProviderCalls,
      sources: result.sources.map((source) => ({
        source: source.source,
        status: source.status,
        received: source.received,
        created: source.created,
        updated: source.updated,
        duplicates: source.duplicates,
        deleted: source.deleted,
        quarantined: source.quarantined,
        checkpointAdvanced: source.checkpointAdvanced,
        retrievalUpdated: source.retrievalUpdated,
        projectionFailed: source.projectionFailed,
        projectionRecoveryQueued: source.projectionRecoveryQueued,
      })),
    });
    return result;
  };
}

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
      retrievalIndex: new RecordingRetrievalIndex(),
    }),
  );
}

export const handler: IngestionHandler = createFixtureIngestionHandler();

export * from './authored-segment.js';
export * from './dynamo-store.js';
export * from './memory-store.js';
export * from './pipeline.js';
export type * from './types.js';
