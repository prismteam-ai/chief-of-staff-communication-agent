import { z } from 'zod';

/**
 * Style profile contract (design.md §6, Task 10): a per-user "style card" extracted from the
 * user's own SENT replies, plus embedded exemplars retrieved at draft time. This module owns the
 * SHAPE only — the DynamoDB style-profiles table (`userId` PK, Task 2 `DataTables`) and the
 * OpenSearch `sent_style` chunks (Task 4/10 `packages/rag`) are the two storage backends this
 * shape flows through; both the agent-handler (build + read) and the api (feedback-loop write)
 * depend on this one contract so a style card built by one Lambda is exactly what the other reads.
 *
 * `StyleCardSchema` fields are the model-facing "voice" attributes design.md §6 names explicitly:
 * tone, typical length, sign-off, formality — plus `greeting` (README L25's "response style" is
 * read broadly enough to include how a reply opens, not just how it closes). All are short,
 * human-readable free text (not raw message bodies) so the extracted card itself carries no PII
 * risk beyond what a style descriptor implies (brief constraint 1: "style-card fields ok —
 * tone/length/formality; NOT raw bodies in logs").
 *
 * NOTE on `lengthBand`: a closed enum, not a free-text description, so `draftReply`'s prompt and
 * any future UI can render it consistently — mirrors `ActionTypeSchema`'s "closed set, not free
 * text" rationale in `action-type.ts`.
 */
export const STYLE_LENGTH_BANDS = ['brief', 'moderate', 'detailed'] as const;
export type StyleLengthBand = (typeof STYLE_LENGTH_BANDS)[number];

export const StyleCardSchema = z.object({
  /** One short phrase describing the user's tone, e.g. "warm, direct, no filler". */
  tone: z.string().min(1),
  /** Typical reply length band, derived from the sampled sent replies' word counts. */
  lengthBand: z.enum(STYLE_LENGTH_BANDS),
  /** The user's characteristic sign-off, e.g. "Best,\nAlex" — verbatim when consistent across the sample. */
  signOff: z.string().min(1),
  /** One short phrase describing formality, e.g. "professional but not stiff". */
  formality: z.string().min(1),
  /** How the user typically opens a reply, e.g. "Hi <first name>,". */
  greeting: z.string().min(1),
});
export type StyleCard = z.infer<typeof StyleCardSchema>;

/**
 * The persisted style-profiles table item (PK `userId` — `lib/constructs/data-tables.ts`).
 * `sourceCount` is the number of sent replies the card was extracted from PLUS every exemplar the
 * feedback loop has since appended (design.md §6 "approved/edited drafts feed back into the
 * profile") — a simple, monotonic "how much has this profile learned from" signal, not used for
 * any gating decision (style is additive to the existing draft, brief constraint 3).
 */
export const StyleProfileRecordSchema = z.object({
  userId: z.string().min(1),
  styleCard: StyleCardSchema,
  sourceCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});
export type StyleProfileRecord = z.infer<typeof StyleProfileRecordSchema>;

/**
 * Renders a `StyleCard` into the short prose block `draftReply`'s prompt injects (design.md §6:
 * "extracted style card ... injected into draft prompts"). One function so the agent-handler's
 * prompt-building and any future consumer (e.g. a dashboard preview) render the identical text.
 */
export function renderStyleCard(card: StyleCard): string {
  return (
    `Write in this user's own voice, learned from their past replies: ${card.tone}. ` +
    `Formality: ${card.formality}. Typical length: ${card.lengthBand}. ` +
    `Open the way they typically do: "${card.greeting}". ` +
    `Close with their typical sign-off: "${card.signOff}".`
  );
}
