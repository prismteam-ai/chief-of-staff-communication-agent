import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

/**
 * Publishes a `{commId, accountId}` trigger to the agent queue after a communication is durably
 * persisted (design.md §5; Task 5 trigger design). This is the ingest→agent hand-off: the ingest
 * processor stays fast and the agent turn runs on its own SQS-backed Lambda with its own retry/DLQ
 * semantics. A publish failure is isolated by the caller (warn + metric) exactly like RAG indexing —
 * an agent-trigger failure must never fail an already-successful ingest.
 */
export interface AgentTrigger {
  publish(input: { commId: string; accountId: string }): Promise<void>;
}

let cachedClient: SQSClient | undefined;
function client(): SQSClient {
  cachedClient ??= new SQSClient({});
  return cachedClient;
}

/** No-op trigger used when `AGENT_QUEUE_URL` is unset (agent stack not yet wired for this deploy). */
export const noopAgentTrigger: AgentTrigger = {
  publish: () => Promise.reject(new Error('AGENT_QUEUE_URL not set — agent trigger unavailable')),
};

export function createAgentTrigger(queueUrl: string): AgentTrigger {
  return {
    async publish({ commId, accountId }) {
      await client().send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ commId, accountId }),
        }),
      );
    },
  };
}
