import { MetricUnit } from '@aws-lambda-powertools/metrics';
import type { NormalizedMessage } from '@chief-of-staff/shared';
import { chunkNormalizedMessage, embedTexts, EMBED_INPUT_TYPE } from '@chief-of-staff/rag';
import type { EmbeddedChunk, RetrievalIndex } from '@chief-of-staff/rag';
import type { logger as LoggerType, metrics as MetricsType } from './context.js';

/**
 * Post-persist embedding step (design.md §4, brief constraint 4): chunk the just-persisted
 * communication's body, embed via the pinned Cohere profile (`input_type: search_document`), and
 * index into OpenSearch. Called from `processOneMessage` AFTER `communicationsRepo.putIngested`
 * succeeds — the communication record is already durably `ingested` by the time this runs, so
 * this step's failure must never undo or fail that outcome.
 *
 * **Failure isolation is the whole point of this being a separate function**: every call site
 * wraps it in its own try/catch (see `processor-logic.ts`) so a Bedrock throttle or an OpenSearch
 * hiccup degrades to a warn log + `ChunkIndexFailed` metric, not a `ProcessOutcome: 'failed'` —
 * the message was still successfully ingested; only its searchability lagged.
 *
 * No PII in logs (brief constraint 4): only channel, chunk count, and error message are logged —
 * never message body, participant addresses, or embedding vectors.
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
