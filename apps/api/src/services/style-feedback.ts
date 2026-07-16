import { chunkSentReply, embedTexts, EMBED_INPUT_TYPE } from '@chief-of-staff/rag';
import type { EmbeddedChunk, RetrievalIndex } from '@chief-of-staff/rag';
import type { StyleProfileRepo } from '@chief-of-staff/agent-handler/style';

/**
 * Task 10 feedback loop (design.md §6 "approved and edited drafts feed back into the profile";
 * alakazam's prior-decision-reuse pattern — the skill's review-loop applied to style). When a draft
 * is approved (as-is) or edited-then-approved and successfully sent, `ApprovalService` calls this
 * hook with the FINAL body — the same text that just went out — so it becomes future retrieval
 * evidence for that user's voice, exactly like a seeded sent-history exemplar (`chunkSentReply`,
 * `apps/agent-handler/src/style/build-style-profile.ts`).
 *
 * Kept as its own small module (not folded into `ApprovalService`) so the service's own tests never
 * need a real/fake `RetrievalIndex` unless they are specifically testing this hook — every other
 * `ApprovalService` test constructs the service with `styleFeedbackHook` omitted and is unaffected.
 */

export interface RecordSentReplyInput {
  userId: string;
  accountId: string;
  /** The communication this reply answers — becomes the exemplar's stable source id, so a retried
   * `approveDraft` call (idempotency, brief constraint 2(d)) upserts the SAME chunk rather than
   * appending a duplicate exemplar for one send. */
  commId: string;
  body: string;
  recipients: string[];
  ts: string;
}

export interface StyleFeedbackHook {
  recordSentReply(input: RecordSentReplyInput): Promise<void>;
}

export interface CreateStyleFeedbackHookDeps {
  styleProfileRepo: StyleProfileRepo;
  retrievalIndex: RetrievalIndex;
  /** Injectable embedder so tests never call Bedrock; defaults to the real Cohere Embed v4 helper. */
  embed?: (texts: string[]) => Promise<number[][]>;
}

/**
 * Production hook: indexes the sent reply as a `sent_style` exemplar (account-scoped, same as
 * every other retrieval — design.md §10) and bumps the style profile's `sourceCount` if one exists
 * yet for this user. `bumpSourceCount` returning `false` (no profile built yet) is expected and
 * benign — the exemplar is still indexed regardless, ready for the FIRST `just build-style-profile`
 * run or a later draft-time retrieval to pick up.
 */
export function createStyleFeedbackHook(deps: CreateStyleFeedbackHookDeps): StyleFeedbackHook {
  const { styleProfileRepo, retrievalIndex } = deps;
  const embed = deps.embed ?? ((texts: string[]) => embedTexts(texts, EMBED_INPUT_TYPE.document));

  return {
    async recordSentReply(input) {
      const chunks = chunkSentReply({
        sourceId: input.commId,
        body: input.body,
        ts: input.ts,
        accountId: input.accountId,
        recipient: input.recipients[0],
      });
      if (chunks.length > 0) {
        const vectors = await embed(chunks.map((c) => c.textForEmbedding));
        const embedded: EmbeddedChunk[] = chunks.map((chunk, i) => ({
          ...chunk,
          embedding: vectors[i]!,
        }));
        await retrievalIndex.indexChunks(embedded);
      }
      await styleProfileRepo.bumpSourceCount(input.userId);
    },
  };
}
