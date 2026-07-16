/**
 * Style-profile seam (design.md §6, Task 5 brief: "Style profile is a stub until Task 10").
 *
 * ## Task 10 fills this in
 * Task 10 (style learning) replaces {@link getStyleProfile} with a real lookup of the per-user
 * learned style card (tone, typical length, sign-off, formality) plus embedded exemplars, read from
 * the style-profiles DynamoDB table and the user's sent-history corpus. Today it returns `null`, and
 * `draftReply` falls back to the generic v0 executive-assistant voice. The seam is deliberately a
 * single function so Task 10 has one obvious place to wire in and nothing downstream changes shape.
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

/**
 * Returns the learned style profile for a user, or `null` when none exists yet. Task 5 always
 * returns `null` (the seam); Task 10 makes it real. `userId` is accepted now so the signature does
 * not change when Task 10 wires it in.
 */
export function getStyleProfile(_userId: string | undefined): StyleProfile | null {
  return null;
}
