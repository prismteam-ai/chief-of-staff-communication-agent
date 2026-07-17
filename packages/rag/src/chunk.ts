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

/**
 * The minimal shape `chunkSentReply` needs (Task 10, design.md §6 "embedded exemplars"). A sent
 * reply is either one of the seeded `sent-history` fixture entries or a just-approved/edited draft
 * fed back by the feedback loop (`apps/api`'s `ApprovalService`) — both shapes reduce to "this text,
 * sent by this user, at this time" before reaching this function, so `chunkSentReply` stays
 * source-agnostic the same way `chunkAsanaTask` stays connector-agnostic.
 */
export interface SentReplyChunkInput {
  /** Stable id for this sent reply — a fixture-derived id for seeded exemplars, or the source
   * commId for a feedback-loop exemplar (each commId can only feed back once — see the repo's
   * idempotency note). */
  sourceId: string;
  body: string;
  /** ISO-8601 timestamp of the sent reply. */
  ts: string;
  /** The account this exemplar belongs to (permission boundary — style exemplars are account-scoped
   * exactly like every other retrieval, design.md §10). */
  accountId: string;
  /** The reply's recipient, when known — carried into `participants` so exemplar retrieval can
   * filter/boost by recipient similarity (brief constraint 2(b): "by topic/recipient similarity"). */
  recipient?: string;
}

/**
 * v1 sent-reply chunking (Task 10): one chunk per sent reply, the whole body, `sourceType:
 * 'sent_style'`. Mirrors `chunkNormalizedMessage`'s whole-body-chunk v1 shape and its empty-body
 * handling so all source types flow through the exact same index/retrieval path.
 */
export function chunkSentReply(input: SentReplyChunkInput): Chunk[] {
  const text = input.body.trim();
  if (text.length === 0) {
    return [];
  }

  const sourceId = `sent#${input.sourceId}`;
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
        channel: 'sent_style',
        accountId: input.accountId,
        participants: input.recipient ? [input.recipient] : [],
        ts: input.ts,
        sourceType: 'sent_style',
      },
    },
  ];
}

/**
 * The minimal shape `chunkAsanaTask` needs from an Asana task (Task 7, design.md §4 "Asana tasks/
 * projects/milestones/comments"). Deliberately a STRUCTURAL subset, not `AsanaTask` from
 * `@chief-of-staff/connectors` — `packages/rag` stays dependency-light (see this module's/
 * package's doc comments: RAG owns no connector deps), so the caller (`scripts/sync-asana.ts`,
 * which already depends on both packages) adapts an `AsanaClient` result into this shape.
 */
export interface AsanaTaskChunkInput {
  gid: string;
  name: string;
  notes?: string;
  completed?: boolean;
  permalinkUrl?: string;
  dueOn?: string | null;
  /** ISO-8601 modification/sync timestamp — becomes the chunk's `ts` metadata. */
  ts: string;
  /** The account this Asana project context is scoped to for this demo (permission boundary). */
  accountId: string;
}

/**
 * v1 Asana chunking (design.md §4: "extends the Task 4 corpus with live Asana context (tasks/
 * projects/milestones/comments indexed)", brief constraint 5: "sync reads ONLY project_gid tasks").
 * One chunk per task, combining name + notes (which already carries the communication provenance
 * back-reference — see `AsanaClient.formatProvenanceNote`) — mirrors `chunkNormalizedMessage`'s
 * whole-body-chunk v1 shape so both source types flow through the exact same index/retrieval path.
 *
 * `asanaGid` is set in metadata so `linking.ts`'s cross-channel `filterSearch` can join a
 * communication's `metadata.asanaGid` back to this chunk (design.md §4 "not embeddings alone").
 *
 * A task with no name AND no notes yields no chunk (nothing meaningful to embed) — mirrors
 * `chunkNormalizedMessage`'s empty-body handling.
 */
export function chunkAsanaTask(task: AsanaTaskChunkInput): Chunk[] {
  const text = [task.name, task.notes].filter((s): s is string => Boolean(s?.trim())).join('\n\n');
  if (text.trim().length === 0) {
    return [];
  }

  const sourceId = `asana#${task.gid}`;
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
        channel: 'asana',
        accountId: task.accountId,
        participants: [],
        asanaGid: task.gid,
        ts: task.ts,
        sourceType: 'asana',
      },
    },
  ];
}
