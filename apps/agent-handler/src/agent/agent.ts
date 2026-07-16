import { Output, stepCountIs, type LanguageModel, type Tool } from 'ai';
import { createLangSmithProviderOptions } from 'langsmith/experimental/vercel';
import type { SuggestedAsanaAction } from '@chief-of-staff/shared';
import {
  RecommendationOutputSchema,
  type RecommendationOutput,
} from '../tools/recommend-action.js';
import { DraftOutputSchema, type DraftOutput } from '../tools/draft-reply.js';
import type { ManageAsanaResult } from '../tools/manage-asana.js';
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
  /**
   * The `manageAsana` tool (Task 7, design.md §9), pre-bound with no client/network dependency —
   * calling it only PROPOSES an Asana action (see `tools/manage-asana.ts`). Optional so tests and
   * any future draft-only caller can omit it; when present, the model may call it once it decides
   * the communication warrants Asana follow-up tracking.
   */
  manageAsanaTool?: Tool;
}

/** `draft()`'s return, extended with the `manageAsana` tool's result when the model called it this
 * turn (Task 7) — `undefined` when the model did not call it. */
export interface DraftResult extends DraftOutput {
  suggestedAsanaAction?: SuggestedAsanaAction;
}

export interface AgentRunner {
  classify(input: ClassifyInput): Promise<RecommendationOutput>;
  draft(input: DraftInput): Promise<DraftResult>;
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

/** Appended to the draft instructions only when a `manageAsana` tool is bound (Task 7). */
const MANAGE_ASANA_INSTRUCTIONS = [
  'If this communication implies concrete follow-up work (a commitment, a deadline, a task someone',
  'owns), call manageAsana to PROPOSE linking it to an Asana task or creating/updating a follow-up',
  'task. manageAsana never performs the write itself — it only records a suggestion for human',
  'review — so call it whenever follow-up tracking would help, even if you are not fully certain.',
  'Skip it for purely informational messages that need no follow-up.',
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

  async draft(input: DraftInput): Promise<DraftResult> {
    const tools: Record<string, Tool> = { retrieveContext: input.retrieveContextTool };
    if (input.manageAsanaTool) {
      tools.manageAsana = input.manageAsanaTool;
    }
    const agent = new this.langsmith.ToolLoopAgent({
      model: this.model,
      tools,
      instructions: `${DRAFT_SYSTEM_PREFIX}\n${input.styleInstructions}\n${MANAGE_ASANA_INSTRUCTIONS}`,
      stopWhen: stepCountIs(MAX_STEPS),
      output: Output.object({ schema: DraftOutputSchema }),
      providerOptions: this.providerOptions(input.sessionId),
    });
    const prompt = `${buildPrompt(input)}\n\nWrite a ${input.actionType} reply draft.`;
    const result = await agent.generate({ prompt });
    const draft = DraftOutputSchema.parse(result.output);

    // Extract the LAST manageAsana tool result this turn, if the model called it (Task 7: the tool
    // only proposes — see tools/manage-asana.ts — so this is never a performed write, only a
    // suggestion to surface for human review). "Last" so a model that calls it more than once in one
    // turn is resolved deterministically to its final proposal, not an arbitrary one.
    const asanaResults = result.toolResults.filter(
      (r): r is typeof r & { output: ManageAsanaResult } =>
        r.toolName === 'manageAsana' && (r as { output?: unknown }).output !== undefined,
    );
    const lastAsanaResult = asanaResults[asanaResults.length - 1];

    return {
      ...draft,
      suggestedAsanaAction: lastAsanaResult?.output.suggestedAsanaAction,
    };
  }
}
