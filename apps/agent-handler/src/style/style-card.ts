import { generateObject, type LanguageModel } from 'ai';
import { StyleCardSchema, type StyleCard } from '@chief-of-staff/shared';

/**
 * Style-card extraction (Task 10, design.md §6, brief constraint 2(a)): a single structured-output
 * Bedrock call over a sample of the user's own SENT replies, producing the {tone, lengthBand,
 * signOff, formality, greeting} card `draftReply` injects into every future draft prompt.
 *
 * One `generateObject` call, not a `ToolLoopAgent` (contrast `agent/agent.ts`'s classify/draft):
 * there is no tool loop here — the whole sent-reply sample is the prompt, and the model's ONLY job
 * is to summarize it into the fixed `StyleCardSchema` shape. `generateObject` is still "ALL LLM
 * interaction goes through the Vercel AI SDK" (Task 5 constraint 2, carried into Task 10) — it is
 * the AI SDK's dedicated structured-output primitive, same family as `Output.object` inside
 * `ToolLoopAgent.generate`.
 *
 * Behind a small port (`StyleCardExtractor`) so `build-style-profile.ts` and its tests inject a
 * fake extractor with a fixed card — no Bedrock, no network — mirroring the `AgentRunner` port
 * `run-agent-turn.test.ts` already uses for `classify`/`draft`.
 */

export interface SentReplySample {
  body: string;
  ts: string;
}

export interface StyleCardExtractor {
  extract(samples: SentReplySample[]): Promise<StyleCard>;
}

const EXTRACTION_SYSTEM = [
  'You are analyzing a sample of one person\'s own SENT email replies to learn their writing',
  'voice. Summarize the consistent patterns across the whole sample — do not describe any single',
  "message. Never quote or repeat a full message body back; describe the PATTERN only (e.g. tone,",
  'typical length, how replies open and close, formality level).',
].join(' ');

function buildPrompt(samples: SentReplySample[]): string {
  const numbered = samples
    .map((s, i) => `--- Sent reply ${i + 1} ---\n${s.body}`)
    .join('\n\n');
  return (
    `Here are ${samples.length} of this person's own sent email replies, oldest pattern signal ` +
    `first:\n\n${numbered}\n\n` +
    'Extract their consistent writing-style card: tone, typical reply length band ' +
    '(brief/moderate/detailed), their characteristic sign-off (verbatim, if consistent across the ' +
    'sample), a short formality descriptor, and how they typically open a reply (greeting style).'
  );
}

/**
 * Production extractor: one `generateObject` call against the pinned chat model. Reuses the same
 * `chatModel` (Bedrock Claude via `@ai-sdk/amazon-bedrock`, `agent/model.ts`) the triage/draft path
 * uses — no second model config, no direct `bedrock-runtime` chat client (Task 5 constraint 2).
 */
export function createBedrockStyleCardExtractor(model: LanguageModel): StyleCardExtractor {
  return {
    async extract(samples) {
      if (samples.length === 0) {
        throw new Error('createBedrockStyleCardExtractor.extract requires at least one sample');
      }
      const result = await generateObject({
        model,
        schema: StyleCardSchema,
        system: EXTRACTION_SYSTEM,
        prompt: buildPrompt(samples),
      });
      return StyleCardSchema.parse(result.object);
    },
  };
}
