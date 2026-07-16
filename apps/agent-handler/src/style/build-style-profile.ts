import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { chunkSentReply, embedTexts, EMBED_INPUT_TYPE } from '@chief-of-staff/rag';
import type { EmbeddedChunk, RetrievalIndex } from '@chief-of-staff/rag';
import type { StyleCard, StyleProfileRecord } from '@chief-of-staff/shared';
import { STYLE_LENGTH_BANDS } from '@chief-of-staff/shared';
import type { StyleCardExtractor, SentReplySample } from './style-card.js';
import type { StyleProfileRepo } from './style-profile-repo.js';
import type { logger as LoggerType, metrics as MetricsType } from '../context.js';

/**
 * `just build-style-profile` orchestration (brief constraint 4): (re)builds one user's style
 * profile from their sent-history corpus — idempotent (a re-run overwrites the style card with a
 * freshly extracted one and upserts exemplar chunks by deterministic id, never duplicating) and
 * account-scoped (every chunk this writes carries the ONE `accountId` passed in; `runAgentTurn`'s
 * `retrieveContext`/exemplar-retrieval permission boundary is what makes that isolation real at
 * read time — see `retrieval-index.test.ts`'s account-scoping assertions).
 *
 * Two outputs, matching design.md §6 exactly:
 *   (a) the extracted style CARD, persisted to the style-profiles table (`StyleCardExtractor`)
 *   (b) the sent replies themselves, indexed as retrievable EXEMPLARS (`chunkSentReply` + the RAG
 *       index) — draft-time retrieval (Task 10(b)) reuses the same account-scoped `RetrievalIndex`
 *       every other retrieval path uses, filtered to `sourceType: 'sent_style'`.
 */

export interface SentReplyInput {
  /** Stable id — the fixture entry's index or a provider message id; namespaced by `chunkSentReply`. */
  sourceId: string;
  body: string;
  ts: string;
  recipient?: string;
}

export interface BuildStyleProfileInput {
  userId: string;
  accountId: string;
  sentReplies: SentReplyInput[];
}

export interface BuildStyleProfileResult {
  styleCard: StyleCard;
  exemplarsIndexed: number;
}

export interface BuildStyleProfileDeps {
  extractor: StyleCardExtractor;
  styleProfileRepo: StyleProfileRepo;
  retrievalIndex: RetrievalIndex;
  log: Pick<typeof LoggerType, 'info' | 'warn'>;
  metricsClient: Pick<typeof MetricsType, 'addMetric'>;
  /** Injectable embedder so tests never call Bedrock; defaults to the real Cohere Embed v4 helper. */
  embed?: (texts: string[]) => Promise<number[][]>;
  now?: () => Date;
  clock?: () => number;
}

/** A card is extracted from at most this many samples — recent-enough to reflect current voice,
 * small enough to stay well under the model's context and keep the extraction call fast. */
export const MAX_STYLE_SAMPLES = 20;

export async function buildStyleProfile(
  input: BuildStyleProfileInput,
  deps: BuildStyleProfileDeps,
): Promise<BuildStyleProfileResult> {
  const { userId, accountId, sentReplies } = input;
  const {
    extractor,
    styleProfileRepo,
    retrievalIndex,
    log,
    metricsClient,
    embed = (texts: string[]) => embedTexts(texts, EMBED_INPUT_TYPE.document),
    now = () => new Date(),
    clock = () => Date.now(),
  } = deps;

  if (sentReplies.length === 0) {
    throw new Error(`buildStyleProfile requires at least one sent reply for user "${userId}"`);
  }

  const startedAt = clock();

  // --- (a) extract + persist the style card --------------------------------------------------
  const samples: SentReplySample[] = sentReplies
    .slice(0, MAX_STYLE_SAMPLES)
    .map((r) => ({ body: r.body, ts: r.ts }));
  const styleCard = await extractor.extract(samples);

  const record: StyleProfileRecord = {
    userId,
    styleCard,
    sourceCount: sentReplies.length,
    updatedAt: now().toISOString(),
  };
  await styleProfileRepo.put(record);
  metricsClient.addMetric('StyleProfileBuilt', MetricUnit.Count, 1);
  log.info('Style profile built', {
    userId,
    sourceCount: record.sourceCount,
    lengthBand: styleCard.lengthBand,
  });

  // --- (b) chunk + embed + index every sent reply as a retrievable exemplar ------------------
  const chunks = sentReplies.flatMap((r) =>
    chunkSentReply({
      sourceId: r.sourceId,
      body: r.body,
      ts: r.ts,
      accountId,
      recipient: r.recipient,
    }),
  );

  let exemplarsIndexed = 0;
  if (chunks.length > 0) {
    const vectors = await embed(chunks.map((c) => c.textForEmbedding));
    const embedded: EmbeddedChunk[] = chunks.map((chunk, i) => ({
      ...chunk,
      embedding: vectors[i]!,
    }));
    await retrievalIndex.indexChunks(embedded);
    exemplarsIndexed = embedded.length;
    metricsClient.addMetric('StyleExemplarAdded', MetricUnit.Count, exemplarsIndexed);
  }

  metricsClient.addMetric('StyleProfileBuildDuration', MetricUnit.Milliseconds, clock() - startedAt);
  log.info('Style exemplars indexed', { userId, exemplarsIndexed });

  return { styleCard, exemplarsIndexed };
}

/** Re-exported so callers building a `SentReplyInput[]` from a fixed length-band vocabulary (e.g.
 * a CLI script printing a summary) share the same closed set `StyleCardSchema` validates against. */
export { STYLE_LENGTH_BANDS };
