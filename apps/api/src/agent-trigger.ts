import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

/**
 * Publishes a `{commId, accountId}` trigger to the agent queue — the SAME queue and message shape
 * `apps/ingest/src/agent-trigger.ts` publishes to after a fresh ingest, reused here for the
 * `supplyContext` re-run hand-off (Task 6 review fix, `approval-service.ts#supplyContext`). Kept as
 * a small app-local copy rather than an import across app package boundaries (mirrors how
 * `communications-repo.ts` is independently defined per app rather than shared) — the agent Lambda
 * doesn't care which producer enqueued the message, only that the shape matches
 * `AgentMessageSchema` in `apps/agent-handler/src/handler.ts`.
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
