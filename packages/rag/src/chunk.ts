import { createHash } from 'node:crypto';
import type { NormalizedMessage } from '@chief-of-staff/shared';
import { commIdFor } from '@chief-of-staff/shared';
import type { Chunk } from './corpus.js';

/**
 * Deterministic chunk id (design.md §4: "chunk_id deterministic (source id + idx + content hash)").
 *
 * Composition: `<sourceId>#<idx>#<first 12 hex of sha256(content)>`.
 *   - `sourceId` + `idx` keep the id greppable back to its origin and unique per chunk position.
 *   - the content hash makes the id change when the body changes, so a re-index after a body edit
 *     writes a NEW document rather than silently overwriting under a colliding id — a body edit is
 *     a new fact, and stale content should not masquerade as fresh under the same key.
 *
 * Same inputs -> same id (safe idempotent upsert on re-ingest of the identical message); different
 * content with the same source+idx -> different id (no silent collision).
 */
export function chunkIdFor(sourceId: string, chunkIndex: number, content: string): string {
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12);
  return `${sourceId}#${chunkIndex}#${contentHash}`;
}

/**
 * v1 chunking (design.md §4: "simple: whole-body chunk v1 + subject line"). One chunk per message
 * carrying the whole body.
 *
 * On the "subject line": `NormalizedMessage` (design.md §3) has no dedicated `subject` field. The
 * Gmail connector folds the subject into `body` at normalization time, so embedding the whole body
 * already embeds the subject — there is no separate subject to concatenate here. When a future
 * channel carries a structured subject, it becomes an additive `NormalizedMessage` field and this
 * function prepends it to `textForEmbedding`; the whole-body-only behavior is documented as the v1
 * deviation from a subject+body split. See the report's "concerns" section.
 *
 * An empty/whitespace-only body yields NO chunk (an empty string cannot be meaningfully embedded
 * and Cohere rejects it) — the message is still ingested and persisted; it simply is not indexed.
 */
export function chunkNormalizedMessage(message: NormalizedMessage): Chunk[] {
  const text = message.body.trim();
  if (text.length === 0) {
    return [];
  }

  const sourceId = commIdFor(message.channelType, message.externalId);
  const chunkIndex = 0;
  const chunkId = chunkIdFor(sourceId, chunkIndex, text);

  return [
    {
      chunkId,
      sourceId,
      chunkIndex,
      textForEmbedding: text,
      textForContext: text,
      metadata: {
        channel: message.channelType,
        accountId: message.accountId,
        participants: message.participants.map((p) => p.id),
        ts: message.ts,
        sourceType: 'communication',
      },
    },
  ];
}
