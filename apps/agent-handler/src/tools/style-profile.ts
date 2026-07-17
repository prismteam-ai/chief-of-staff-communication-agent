import { renderStyleCard, type StyleProfileRecord } from '@chief-of-staff/shared';
import type { RetrievalIndex } from '@chief-of-staff/rag';
import { embedText, EMBED_INPUT_TYPE } from '@chief-of-staff/rag';
import type { StyleProfileRepo } from '../style/style-profile-repo.js';

/**
 * Style-profile seam (design.md §6). Task 5 left this returning `null` unconditionally (the
 * generic v0 voice); Task 10 fills it in: a real lookup of the per-user learned style card
 * (design.md §6 "tone, typical length, sign-off, formality") plus the user's own past sent replies
 * retrieved as embedded exemplars, most relevant to the communication currently being drafted
 * (brief constraint 2(b): "by topic/recipient similarity" — approximated here by querying the
 * exemplar index with the message text itself, the same account-scoped hybrid search
 * `retrieveContext` already performs, filtered to `sourceType: 'sent_style'`).
 */

export interface StyleProfile {
  /** Short human-readable style card injected into the draft prompt. */
  styleCard: string;
  /** Optional exemplar snippets of the user's own prior replies (Task 10 populates these). */
  exemplars: string[];
}

/**
 * Generic v0 voice used until a real profile exists — a helpful, concise, professional
 * executive-assistant tone. Kept as an exported constant so `draftReply` and its tests reference
 * the same baseline.
 */
export const GENERIC_STYLE_CARD =
  'Write as a helpful, concise, professional executive assistant: courteous, direct, no filler, ' +
  'plain business English, a brief sign-off. Never invent facts not present in the message or the ' +
  'retrieved context.';

/** How many past sent replies to retrieve as embedded exemplars (brief constraint 2(b): "a few"). */
export const STYLE_EXEMPLAR_TOP_K = 3;

export interface GetStyleProfileDeps {
  /** Absent (e.g. a call site that predates Task 10's wiring) -> always falls back to `null`. */
  styleProfileRepo?: StyleProfileRepo;
  retrievalIndex?: RetrievalIndex;
  /** The account being drafted for — the permission boundary for exemplar retrieval. */
  accountId?: string;
  /** The message text being replied to — used to retrieve the MOST RELEVANT past exemplars, not
   * just the most recent (topic/recipient similarity, brief constraint 2(b)). */
  messageText?: string;
  /** Injectable embedder so tests never call Bedrock; defaults to the real Cohere Embed v4 helper. */
  embed?: (text: string) => Promise<number[]>;
}

/**
 * Returns the learned style profile for a user, or `null` when none exists yet (no `userId`, the
 * style-profile deps were never wired at the call site, or `build-style-profile` has never run for
 * this user — `draftReply` falls back to the generic v0 voice in every case, exactly as it did
 * before Task 10).
 */
export async function getStyleProfile(
  userId: string | undefined,
  deps: GetStyleProfileDeps,
): Promise<StyleProfile | null> {
  if (!userId || !deps.styleProfileRepo) return null;

  const record: StyleProfileRecord | undefined = await deps.styleProfileRepo.get(userId);
  if (!record) return null;

  const embed = deps.embed ?? ((text: string) => embedText(text, EMBED_INPUT_TYPE.query));
  const exemplars = await retrieveExemplars(deps, embed);

  return { styleCard: renderStyleCard(record.styleCard), exemplars };
}

/**
 * Best-effort exemplar retrieval: a search failure (e.g. RAG domain unavailable) degrades to NO
 * exemplars rather than failing the whole draft — mirrors `retrieveContext`'s own degrade-on-error
 * shape (that tool's doc comment: "the agent classifies with no retrieved context"). The style
 * CARD (already resolved above) is still applied even if exemplar retrieval fails.
 */
async function retrieveExemplars(
  deps: GetStyleProfileDeps,
  embed: (text: string) => Promise<number[]>,
): Promise<string[]> {
  const query = deps.messageText?.trim();
  if (!query || !deps.retrievalIndex || !deps.accountId) return [];

  try {
    const queryEmbedding = await embed(query);
    const hits = await deps.retrievalIndex.search(queryEmbedding, query, {
      accountId: deps.accountId,
      topK: STYLE_EXEMPLAR_TOP_K,
      filters: { sourceType: 'sent_style' },
    });
    return hits.map((h) => h.textForContext);
  } catch {
    return [];
  }
}
