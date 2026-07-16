import type { ChannelType } from '@chief-of-staff/shared';
import type { Connector } from '@chief-of-staff/connectors';
import { router } from '../trpc.js';
import { healthRouter } from './health.js';
import { createCommunicationsRouter } from './communications.js';
import { ApprovalService } from '../services/approval-service.js';
import { createCommunicationsRepo } from '../repos/communications-repo.js';
import { createAccountsRepo } from '../repos/accounts-repo.js';
import { createRealGmailConnector } from '../gmail-send.js';
import { createAgentTrigger, noopAgentTrigger } from '../agent-trigger.js';
import { loadApiRuntimeEnv } from '../env.js';
import { logger, metrics } from '../context.js';

const env = loadApiRuntimeEnv();

// Module-level singletons — one per Lambda execution environment, same convention as
// `apps/ingest/src/processor-handler.ts` / `apps/agent-handler/src/handler.ts`. The Gmail
// connector is built lazily/cached so a cold start with no communications table configured (e.g.
// unit tests importing this module indirectly) never throws at import time.
let cachedApprovalService: ApprovalService | undefined;

function connectorFor(channelType: ChannelType): Connector | undefined {
  // Gmail is the only sendable channel wired today (design.md's Live tier — channel-access-tiers.md);
  // other channels return undefined, which `ApprovalService.approveDraft` turns into a clear
  // IllegalActionError rather than a crash.
  if (channelType === 'gmail') return createRealGmailConnector();
  return undefined;
}

function approvalService(): ApprovalService {
  if (!cachedApprovalService) {
    if (!env.communicationsTableName || !env.accountsTableName) {
      throw new Error('COMMUNICATIONS_TABLE_NAME and ACCOUNTS_TABLE_NAME must be set');
    }
    cachedApprovalService = new ApprovalService({
      communicationsRepo: createCommunicationsRepo(env.communicationsTableName),
      accountsRepo: createAccountsRepo(env.accountsTableName),
      connectorFor,
      // Unset AGENT_QUEUE_URL (agent stack not wired for this deploy) degrades to a clear
      // IllegalActionError-free warn+metric inside supplyContext, never a crash — same posture as
      // `connectorFor` returning `undefined` for a channel with no sendable connector.
      agentTrigger: env.agentQueueUrl ? createAgentTrigger(env.agentQueueUrl) : noopAgentTrigger,
      log: logger,
      metricsClient: metrics,
    });
  }
  return cachedApprovalService;
}

export const appRouter = router({
  health: healthRouter,
  communications: createCommunicationsRouter(() => approvalService()),
});

export type AppRouter = typeof appRouter;
