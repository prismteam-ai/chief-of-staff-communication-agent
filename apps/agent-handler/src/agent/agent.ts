import { Output, stepCountIs, type LanguageModel, type Tool } from 'ai';
import { createLangSmithProviderOptions } from 'langsmith/experimental/vercel';
import {
  RecommendationOutputSchema,
  type RecommendationOutput,
} from '../tools/recommend-action.js';
import { DraftOutputSchema, type DraftOutput } from '../tools/draft-reply.js';
import { BEDROCK_PROMPT_CACHE_METADATA } from './bedrock-prompt-cache.js';
import type { LangSmithFacade } from '../observability/langsmith.js';

/**
 * The agent's LLM interaction surface, behind a small port so the orchestration
 * (`run-agent-turn.ts`) and its tests never touch Bedrock directly. Tests inject a fake `AgentRunner`
 * with fixed outputs; production uses `ToolLoopAgentRunner`, which drives the Vercel AI SDK
 * `ToolLoopAgent` (Task 5 constraint 2: ALL LLM interaction goes through the AI SDK — no direct
 * bedrock-runtime chat client).
 *
 * Two operations map to two of the shared tools' outputs:
 *  - `classify` → `RecommendationOutput` ({actionType, confidence, rationale})
 *  - `draft`    → `DraftOutput` ({body, confidence})
 *
 * The confidence GATE is NOT here — it is applied in code by `run-agent-turn.ts` after `classify`
 * returns (Task 5 constraint 3). The runner only produces the structured outputs.
 */
export interface ClassifyInput {
  sessionId: string;
  /** The message being triaged (body). No PII leaves this process beyond the model call. */
  messageText: string;
  /** Prior conversation turns as plain text, oldest first. */
  history: string[];
  /** The `retrieveContext` tool, pre-bound to the account being triaged. */
  retrieveContextTool: Tool;
}

export interface DraftInput extends ClassifyInput {
  /** The classification the draft is written for (so the draft matches the decided action). */
  actionType: string;
  /** Style instructions (generic v0 today; Task 10 makes them user-specific). */
  styleInstructions: string;
}

export interface AgentRunner {
  classify(input: ClassifyInput): Promise<RecommendationOutput>;
  draft(input: DraftInput): Promise<DraftOutput>;
}

const CLASSIFY_SYSTEM = [
  'You are Pidgeot, the Chief of Staff communication-triage agent.',
  'Your job is to classify one inbound communication into exactly one action type and justify it.',
  'Action types:',
  '- reply_needed: the sender expects a response from us; a draft should follow.',
  '- fyi_no_reply: informational (newsletters, notifications, CC-only); no reply owed.',
  '- schedule: a meeting/calendar request needing a scheduling action.',
  '- delegate: the work belongs to someone else; hand it off.',
  '- escalate: urgent or high-stakes; surface to the principal rather than auto-handling.',
  '- needs_context: you cannot classify or act confidently and need more information.',
  'Use the retrieveContext tool to ground your decision in prior threads and org knowledge when it',
  'would change the classification. Set confidence honestly in [0,1]; when genuinely unsure, lower',
  'it rather than guessing high. Never include the verbatim message body in your rationale.',
].join('\n');

const DRAFT_SYSTEM_PREFIX = [
  'You are Pidgeot, the Chief of Staff communication-triage agent, writing a reply draft.',
  'Ground the draft in the retrieved context; never invent facts not present in the message or',
  'that context. Produce a complete, ready-to-send body and an honest confidence in [0,1].',
  'Follow this voice:',
].join('\n');

/** Step-count guard so a tool loop can never run away (kit skill: "Limit tool iterations"). */
const MAX_STEPS = 6;

function buildPrompt(input: ClassifyInput): string {
  const historyBlock =
    input.history.length > 0
      ? `Prior turns in this thread (oldest first):\n${input.history.join('\n---\n')}\n\n`
      : '';
  return `${historyBlock}Communication to triage:\n${input.messageText}`;
}

/**
 * Production runner: drives the LangSmith-wrapped `ToolLoopAgent` (raw when tracing is off). Each
 * operation is a single `agent.generate({ prompt })` with an `Output.object` structured schema, so
 * the AI SDK validates the output shape for us and the tool loop (retrieveContext) runs inside it.
 *
 * ## API-letter deviation (documented, Task 5 constraint 1)
 * The kit skill's example calls `agent.run(prompt)`. In the pinned `ai@7.0.29`, `ToolLoopAgent` has
 * NO `.run()` — only `.generate(...)` (non-streaming) and `.stream(...)`. This runner uses
 * `agent.generate({ prompt })`. (Also: AI SDK v7 tools use `inputSchema`, not the skill's
 * `parameters` — reflected in the tool definitions.)
 */
export class ToolLoopAgentRunner implements AgentRunner {
  constructor(
    private readonly model: LanguageModel,
    private readonly langsmith: LangSmithFacade,
  ) {}

  private providerOptions(sessionId: string) {
    if (!this.langsmith.tracingEnabled) return undefined;
    return {
      langsmith: createLangSmithProviderOptions({
        metadata: {
          ls_provider: 'anthropic',
          ls_model_name: 'claude-sonnet-4-6',
          ...BEDROCK_PROMPT_CACHE_METADATA,
          session_id: sessionId,
        },
      }),
    };
  }

  async classify(input: ClassifyInput): Promise<RecommendationOutput> {
    const agent = new this.langsmith.ToolLoopAgent({
      model: this.model,
      tools: { retrieveContext: input.retrieveContextTool },
      instructions: CLASSIFY_SYSTEM,
      stopWhen: stepCountIs(MAX_STEPS),
      output: Output.object({ schema: RecommendationOutputSchema }),
      providerOptions: this.providerOptions(input.sessionId),
    });
    const result = await agent.generate({ prompt: buildPrompt(input) });
    return RecommendationOutputSchema.parse(result.output);
  }

  async draft(input: DraftInput): Promise<DraftOutput> {
    const agent = new this.langsmith.ToolLoopAgent({
      model: this.model,
      tools: { retrieveContext: input.retrieveContextTool },
      instructions: `${DRAFT_SYSTEM_PREFIX}\n${input.styleInstructions}`,
      stopWhen: stepCountIs(MAX_STEPS),
      output: Output.object({ schema: DraftOutputSchema }),
      providerOptions: this.providerOptions(input.sessionId),
    });
    const prompt = `${buildPrompt(input)}\n\nWrite a ${input.actionType} reply draft.`;
    const result = await agent.generate({ prompt });
    return DraftOutputSchema.parse(result.output);
  }
}
