import { MetricUnit } from '@aws-lambda-powertools/metrics';
import type { NormalizedMessage } from '@chief-of-staff/shared';
import { chunkNormalizedMessage, embedTexts, EMBED_INPUT_TYPE } from '@chief-of-staff/rag';
import type { EmbeddedChunk, RetrievalIndex } from '@chief-of-staff/rag';
import type { logger as LoggerType, metrics as MetricsType } from './context.js';

/**
 * Post-persist embedding step for the WhatsApp inbound webhook (Task 9) — identical shape/
 * semantics to `apps/ingest/src/rag-index-step.ts#indexMessageChunks`: chunk the just-persisted
 * communication's body, embed via the pinned Cohere profile, index into OpenSearch. A small
 * app-local copy rather than a cross-app import (same convention `communications-repo.ts` and
 * `agent-trigger.ts` already follow in this app) — the webhook Lambda lives in `apps/api` (it must
 * share the deployed API Gateway's stable URL), not `apps/ingest`.
 *
 * Failure isolation is the caller's job (see `whatsapp-inbound.ts`'s `indexChunksIsolated`): the
 * communication record is already durably `ingested` by the time this runs, so this step's failure
 * must never undo or fail that outcome. No PII in logs — only channel, chunk count, error message.
 */
export async function indexMessageChunks(
  message: NormalizedMessage,
  deps: {
    retrievalIndex: RetrievalIndex;
    log: Pick<typeof LoggerType, 'info' | 'warn'>;
    metricsClient: Pick<typeof MetricsType, 'addMetric' | 'addDimension'>;
  },
): Promise<void> {
  const { retrievalIndex, log, metricsClient } = deps;

  const chunks = chunkNormalizedMessage(message);
  if (chunks.length === 0) {
    log.info('No chunks produced for message (empty body) — nothing to index', {
      channelType: message.channelType,
    });
    return;
  }

  const vectors = await embedTexts(
    chunks.map((c) => c.textForEmbedding),
    EMBED_INPUT_TYPE.document,
  );

  const embedded: EmbeddedChunk[] = chunks.map((chunk, i) => ({
    ...chunk,
    embedding: vectors[i]!,
  }));

  await retrievalIndex.indexChunks(embedded);

  metricsClient.addDimension('channel', message.channelType);
  metricsClient.addMetric('ChunkIndexed', MetricUnit.Count, embedded.length);
  log.info('Indexed communication chunk(s)', {
    channelType: message.channelType,
    chunkCount: embedded.length,
  });
}
