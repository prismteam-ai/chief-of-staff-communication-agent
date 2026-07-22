import { createObservability } from '@chief/observability';

import type { CanonicalIngestionPipeline } from './pipeline.js';
import type { IngestionEvent, IngestionResult } from './types.js';

const observability = createObservability('chief-ingestion-worker');
type MetricUnit = Parameters<typeof observability.metrics.addMetric>[1];
const COUNT = 'Count' as MetricUnit;
const MILLISECONDS = 'Milliseconds' as MetricUnit;

export type IngestionHandler = (
  event: IngestionEvent,
) => Promise<IngestionResult>;

export function createIngestionHandler(
  pipeline: CanonicalIngestionPipeline,
): IngestionHandler {
  return async (event) => {
    const startedAt = Date.now();
    try {
      const result = await pipeline.process(event);
      observability.metrics.addMetric(
        'RecordIngested',
        COUNT,
        result.processed,
      );
      observability.metrics.addMetric(
        'RecordFailed',
        COUNT,
        result.quarantined + result.projectionFailures,
      );
      observability.metrics.addMetric(
        'ProcessingDuration',
        MILLISECONDS,
        result.durationMs,
      );
      observability.logger.info('Canonical ingestion invocation complete', {
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
    } catch (error) {
      observability.metrics.addMetric('RecordFailed', COUNT, 1);
      observability.metrics.addMetric(
        'ProcessingDuration',
        MILLISECONDS,
        Math.max(0, Date.now() - startedAt),
      );
      observability.logger.error('Canonical ingestion invocation failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    } finally {
      observability.metrics.publishStoredMetrics();
    }
  };
}
