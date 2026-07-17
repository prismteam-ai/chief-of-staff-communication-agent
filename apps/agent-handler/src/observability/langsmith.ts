import * as ai from 'ai';
import { Client } from 'langsmith';
import { wrapAISDK } from 'langsmith/experimental/vercel';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { RuntimeEnv } from '../env.js';
import { logger } from '../context.js';

/**
 * LangSmith telemetry facade (kit skill `observability-langsmith-telemetry.md`, Task 5 constraint
 * 5: LangSmith with graceful degradation — it must NEVER cause an agent turn to hard-fail because
 * it is unconfigured). When tracing is enabled and an API key resolves, the facade returns the
 * wrapped `ToolLoopAgent`/`generateText`; otherwise it returns the raw AI SDK functions and a
 * no-op `flush`. Traces are grouped by session (thread key) via `LANGSMITH_PROJECT=pidgeot-agent`
 * plus per-run session metadata set at the call site.
 */
export type LangSmithFacade = {
  tracingEnabled: boolean;
  ToolLoopAgent: typeof ai.ToolLoopAgent;
  flush: () => Promise<void>;
};

function tracingEnabled(env: RuntimeEnv): boolean {
  return env.langsmithTracing.toLowerCase() !== 'false';
}

let cachedKey: string | undefined;

async function loadSecretString(arn: string, region: string): Promise<string | undefined> {
  try {
    const client = new SecretsManagerClient({ region });
    const result = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    return result.SecretString?.trim() || undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Could not read LangSmith API key secret — tracing disabled for this turn.', {
      error: message,
    });
    return undefined;
  }
}

async function resolveApiKey(env: RuntimeEnv): Promise<string | undefined> {
  if (env.langsmithApiKey) {
    return env.langsmithApiKey;
  }
  const arn = env.langsmithApiKeySecretArn;
  if (!arn) return undefined;
  if (cachedKey) return cachedKey;

  const value = await loadSecretString(arn, env.region);
  if (value) cachedKey = value;
  return cachedKey;
}

function disabledFacade(): LangSmithFacade {
  return {
    tracingEnabled: false,
    ToolLoopAgent: ai.ToolLoopAgent,
    flush: async () => {},
  };
}

/**
 * Build the facade at bootstrap or per-invocation. Resolves the API key lazily from Secrets Manager
 * (cached after the first fetch), sets the LangSmith SDK's `process.env` knobs, and wraps the AI
 * SDK. Any failure degrades to the disabled facade rather than throwing.
 */
export async function createLangSmithFacade(env: RuntimeEnv): Promise<LangSmithFacade> {
  if (!tracingEnabled(env)) {
    return disabledFacade();
  }

  const key = await resolveApiKey(env);
  if (!key) {
    return disabledFacade();
  }

  try {
    process.env.LANGSMITH_API_KEY = key;
    process.env.LANGSMITH_ENDPOINT = env.langsmithEndpoint;
    process.env.LANGSMITH_PROJECT = env.langsmithProject;
    process.env.LANGSMITH_TRACING = 'true';

    const client = new Client();
    const wrapped = wrapAISDK(ai, { client });

    return {
      tracingEnabled: true,
      ToolLoopAgent: wrapped.ToolLoopAgent ?? ai.ToolLoopAgent,
      flush: () => client.awaitPendingTraceBatches(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('LangSmith facade construction failed — continuing without tracing.', {
      error: message,
    });
    return disabledFacade();
  }
}
