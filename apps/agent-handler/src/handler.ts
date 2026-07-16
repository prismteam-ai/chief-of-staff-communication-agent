import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import middy from '@middy/core';
import { z } from 'zod';
import { loadRuntimeEnv } from './env.js';
import { logger, metrics, tracer } from './context.js';
import { chatModel } from './agent/model.js';
import { createLangSmithFacade } from './observability/langsmith.js';
import { ToolLoopAgentRunner } from './agent/agent.js';
import { createAgentCommunicationsRepo } from './communications-repo.js';
import { createConversationEventStore } from './memory/conversation-event-store.js';
import { createRetrievalIndex } from './retrieval-index.js';
import { runAgentTurn } from './run-agent-turn.js';

/**
 * SQS-triggered agent runtime (design.md §5; trigger design per Task 5 brief constraint 4). The
 * ingest processor publishes one `{commId, accountId}` message per newly-ingested communication to
 * the agent queue AFTER the communication is durably persisted; this handler runs the agent turn.
 *
 * ## Why SQS fan-out (not a direct async invoke from the processor)
 * An agent turn runs a Bedrock tool loop and can take many seconds. Blocking the ingest processor
 * on it would risk the ingest queue's own visibility-timeout/redelivery races. A dedicated
 * agent queue decouples the two: ingestion stays fast, and the agent turn gets its OWN retry + DLQ
 * semantics (`ReportBatchItemFailures` here → maxReceiveCount → agent DLQ + alarm) so an
 * agent-turn failure is visible and retried, never silently lost. The processor's publish is
 * isolated the same way its RAG indexing is (a publish failure warns + counts; it never fails
 * ingestion). See `lib/stacks/agent-stack.ts` for the full rationale.
 */

const env = loadRuntimeEnv();

const AgentMessageSchema = z.object({
  commId: z.string().min(1),
  accountId: z.string().min(1),
});

// Module-scope singletons reused across warm invocations (kit skill: keep model/store at module
// scope). The communications repo and retrieval index are cheap wrappers over cached clients.
const communicationsRepo = createAgentCommunicationsRepo(env.communicationsTableName);
const conversationStore = createConversationEventStore(env);
const retrievalIndex = createRetrievalIndex(env);

function requireEnv(): void {
  if (!env.communicationsTableName) {
    throw new Error('COMMUNICATIONS_TABLE_NAME must be set');
  }
}

async function baseHandler(event: SQSEvent): Promise<SQSBatchResponse> {
  requireEnv();

  // The LangSmith facade is built per-invocation so its per-invocation trace batches flush cleanly;
  // the AgentRunner wraps the module-scope model with this facade.
  const langsmith = await createLangSmithFacade(env);
  const agentRunner = new ToolLoopAgentRunner(chatModel, langsmith);

  const batchItemFailures: { itemIdentifier: string }[] = [];

  try {
    for (const record of event.Records) {
      let parsed: { commId: string; accountId: string };
      try {
        parsed = AgentMessageSchema.parse(JSON.parse(record.body));
      } catch {
        logger.error('Unparseable agent SQS record body — routing to DLQ', {
          messageId: record.messageId,
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const result = await runAgentTurn(parsed, {
        communicationsRepo,
        retrievalIndex,
        agentRunner,
        conversationStore,
        log: logger,
        metricsClient: metrics,
      });

      // A failed turn is reported so ONLY that record redelivers (eventually to the agent DLQ),
      // rather than the whole batch retrying and re-running already-succeeded turns.
      if (result.outcome === 'failed') {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
  } finally {
    // Always flush LangSmith before returning — pending trace batches are lost otherwise in the
    // Lambda lifecycle (kit skill key rule 3).
    await langsmith.flush();
  }

  return { batchItemFailures };
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger, { logEvent: false }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics, { captureColdStartMetric: true }));
