import { MetricUnit as MetricUnitValue } from '@aws-lambda-powertools/metrics';
import { chunkSentReply, embedTexts, EMBED_INPUT_TYPE } from '@chief-of-staff/rag';
import type { EmbeddedChunk, RetrievalIndex } from '@chief-of-staff/rag';
import type { StyleCard, StyleProfileRecord } from '@chief-of-staff/shared';
import { STYLE_LENGTH_BANDS } from '@chief-of-staff/shared';
import type { StyleCardExtractor, SentReplySample } from './style-card.js';
import type { StyleProfileRepo } from './style-profile-repo.js';

/** `MetricUnit` (`@aws-lambda-powertools/metrics`) is exported as a value only from the package's
 * main entry point, not as a type — this derives the same union type from that value so
 * `StyleMetricsClient` can reference it without a second, colliding import. */
type MetricUnit = (typeof MetricUnitValue)[keyof typeof MetricUnitValue];

/**
 * Minimal logger/metrics ports — NOT `Pick<typeof LoggerType/MetricsType, ...>` from `../context.js`
 * as every other module in this app does, because `buildStyleProfile` has TWO call sites in two
 * different runtimes: the agent Lambda (Task 10's `just build-style-profile` could run inline in a
 * future Lambda-triggered rebuild) and, today, the `just build-style-profile` operator SCRIPT
 * (`scripts/build-style-profile.ts`), which is not a Lambda and has no Powertools `Metrics`
 * instance to flush (same rationale `scripts/sync-asana.ts`'s module doc gives for using
 * `PutMetricDataCommand` directly there). A narrow structural interface lets both a real Powertools
 * `Logger`/`Metrics` instance AND a plain `PutMetricDataCommand`-backed adapter satisfy the same
 * dependency.
 */
export interface StyleLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}
export interface StyleMetricsClient {
  addMetric(name: string, unit: MetricUnit, value: number): void;
}

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
  log: StyleLogger;
  metricsClient: StyleMetricsClient;
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

  // Final-review fix: `sourceCount` must never regress on a rebuild. `sentReplies.length` is only
  // THIS rebuild's corpus snapshot (`scripts/build-style-profile.ts` pulls up to
  // `SENT_HISTORY_MAX` Gmail SENT messages) — but the feedback loop
  // (`apps/api/src/services/style-feedback.ts#recordSentReply`, called for every channel's
  // approved/edited-then-sent reply, not just Gmail) bumps `sourceCount` by 1 independently of
  // this rebuild. Overwriting with the raw corpus size would silently erase any feedback-driven
  // growth accumulated since the profile was last built (e.g. a WhatsApp send this rebuild's
  // Gmail-only fetch never sees). Taking the max preserves whichever signal is larger — the
  // corpus genuinely grew, or feedback already pushed the count higher — without inflating the
  // count on a back-to-back rebuild of the same unchanged corpus.
  const existingProfile = await styleProfileRepo.get(userId);
  const sourceCount = Math.max(sentReplies.length, existingProfile?.sourceCount ?? 0);

  const record: StyleProfileRecord = {
    userId,
    styleCard,
    sourceCount,
    updatedAt: now().toISOString(),
  };
  await styleProfileRepo.put(record);
  metricsClient.addMetric('StyleProfileBuilt', MetricUnitValue.Count, 1);
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
    metricsClient.addMetric('StyleExemplarAdded', MetricUnitValue.Count, exemplarsIndexed);
  }

  metricsClient.addMetric(
    'StyleProfileBuildDuration',
    MetricUnitValue.Milliseconds,
    clock() - startedAt,
  );
  log.info('Style exemplars indexed', { userId, exemplarsIndexed });

  return { styleCard, exemplarsIndexed };
}

/** Re-exported so callers building a `SentReplyInput[]` from a fixed length-band vocabulary (e.g.
 * a CLI script printing a summary) share the same closed set `StyleCardSchema` validates against. */
export { STYLE_LENGTH_BANDS };
