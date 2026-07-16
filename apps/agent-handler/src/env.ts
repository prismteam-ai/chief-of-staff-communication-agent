/**
 * Runtime environment contract for the agent Lambda. Read from `process.env` once, at module load,
 * so the handler and the module-scope singletons (model, LangSmith facade, event store) see a
 * consistent view. Every value here is a non-secret configuration knob or a Secrets Manager ARN —
 * never a secret literal (design.md §10, §12).
 */
export interface RuntimeEnv {
  readonly region: string;
  readonly bedrockModelId: string;
  readonly communicationsTableName: string;
  readonly ragDomainEndpoint: string;
  /** AgentCore Memory id. Unset → the Noop event store is used (never a hard failure). */
  readonly agentcoreMemoryId: string;
  /** Max conversation events loaded per turn (kit skill default: 200). */
  readonly chatHistoryEventLimit: number;
  readonly langsmithApiKey: string;
  readonly langsmithApiKeySecretArn: string;
  readonly langsmithProject: string;
  readonly langsmithEndpoint: string;
  readonly langsmithTracing: string;
}

const DEFAULT_CHAT_HISTORY_EVENT_LIMIT = 200;
const DEFAULT_LANGSMITH_ENDPOINT = 'https://api.smith.langchain.com';
/** design.md §5: `LANGSMITH_PROJECT=pidgeot-agent`. */
const DEFAULT_LANGSMITH_PROJECT = 'pidgeot-agent';
/** Pinned chat model — matches the kit skill and the mission's live-verified access (Task 5). */
const DEFAULT_BEDROCK_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';

export function loadRuntimeEnv(source: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  const limitRaw = source.CHAT_HISTORY_EVENT_LIMIT?.trim();
  const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;

  return {
    // AWS_REGION is auto-injected by the Lambda runtime (see api-stack.ts note); default only for
    // local tests / scripts.
    region: source.AWS_REGION?.trim() || 'us-east-2',
    bedrockModelId: source.BEDROCK_MODEL_ID?.trim() || DEFAULT_BEDROCK_MODEL_ID,
    communicationsTableName: source.COMMUNICATIONS_TABLE_NAME?.trim() ?? '',
    ragDomainEndpoint: source.RAG_DOMAIN_ENDPOINT?.trim() ?? '',
    agentcoreMemoryId: source.AGENTCORE_MEMORY_ID?.trim() ?? '',
    chatHistoryEventLimit: Number.isFinite(parsedLimit)
      ? parsedLimit
      : DEFAULT_CHAT_HISTORY_EVENT_LIMIT,
    langsmithApiKey: source.LANGSMITH_API_KEY?.trim() ?? '',
    langsmithApiKeySecretArn: source.LANGSMITH_API_KEY_SECRET_ARN?.trim() ?? '',
    langsmithProject: source.LANGSMITH_PROJECT?.trim() || DEFAULT_LANGSMITH_PROJECT,
    langsmithEndpoint: source.LANGSMITH_ENDPOINT?.trim() || DEFAULT_LANGSMITH_ENDPOINT,
    langsmithTracing: source.LANGSMITH_TRACING?.trim() || 'true',
  };
}
