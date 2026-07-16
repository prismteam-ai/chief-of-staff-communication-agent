import { z } from 'zod';
import { CHANNEL_TYPES } from '@chief-of-staff/shared';

/**
 * The corpus contract (design.md §4, brief constraint 4). One `Chunk` is the durable retrievable
 * record indexed into OpenSearch. Communications produce chunks; so do seeded org documents, user
 * preferences, and (Task 7) Asana context — all share this one shape so the index, the retrieval
 * interface, and the golden-query harness never branch on source.
 *
 * `text_for_embedding` / `text_for_context` are split deliberately: the first is what gets embedded
 * and lexically searched (the searchable surface); the second is what a downstream consumer shows
 * or hands to the agent as grounded evidence (the citation surface). They are usually equal for a
 * plain communication but diverge for structured sources (an org doc's context may carry a title +
 * section header the embedding text omits).
 */

/**
 * Where a chunk came from. `communication` = a NormalizedMessage; `asana` = Asana task/project/
 * comment context (shape ready now, populated in Task 7); `org_doc` = seeded organizational
 * knowledge; `preference` = a seeded/edited user preference or style note; `sent_style` = one of
 * the user's own SENT replies, indexed as a style EXEMPLAR (Task 10, design.md §6: "embedded
 * exemplars retrieved at draft time"). Distinct from `communication` even though a sent reply IS a
 * communication, because `sent_style` chunks are retrieved for a different purpose (voice-matching
 * at draft time, filtered to the drafting user's own account) and must never be conflated with the
 * general cross-channel retrieval `retrieveContext` performs.
 */
export const SOURCE_TYPES = ['communication', 'asana', 'org_doc', 'preference', 'sent_style'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const ChunkMetadataSchema = z.object({
  /** Channel for a communication chunk; the source system otherwise (`asana`, `org_doc`, ...). */
  channel: z.enum(CHANNEL_TYPES).or(z.enum(SOURCE_TYPES)),
  /**
   * The permission boundary. EVERY retrieval filters on this (design.md §10). Named `account_id`
   * in the index; carried here as `accountId` to match the codebase's camelCase domain contracts.
   */
  accountId: z.string().min(1),
  /** Provider-native participant identities (emails, phone numbers, handles) for link filters. */
  participants: z.array(z.string()).default([]),
  /** Optional cross-channel linking dimensions (design.md §4 "not embeddings alone"). */
  topic: z.string().optional(),
  project: z.string().optional(),
  asanaGid: z.string().optional(),
  /** ISO-8601 timestamp of the underlying communication/record (not index time). */
  ts: z.string().datetime(),
  sourceType: z.enum(SOURCE_TYPES),
});
export type ChunkMetadata = z.infer<typeof ChunkMetadataSchema>;

export const ChunkSchema = z.object({
  /** Deterministic id: `<sourceId>#<idx>#<contentHash>` — see `chunkIdFor`. */
  chunkId: z.string().min(1),
  /** The id of the source record this chunk derives from (e.g. a `commId`). */
  sourceId: z.string().min(1),
  /** Index of this chunk within its source (0-based); v1 chunking emits a single chunk (idx 0). */
  chunkIndex: z.number().int().nonnegative(),
  textForEmbedding: z.string().min(1),
  textForContext: z.string().min(1),
  metadata: ChunkMetadataSchema,
});
export type Chunk = z.infer<typeof ChunkSchema>;

/** A chunk plus its embedding vector, ready to index. */
export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}
