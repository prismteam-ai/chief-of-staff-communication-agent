import type { ChannelType } from '@chief-of-staff/shared';
import type { Connector } from '@chief-of-staff/connectors';
import { AsanaClient } from '@chief-of-staff/connectors/asana';
import { createStyleProfileRepo } from '@chief-of-staff/agent-handler/style';
import {
  createSignedOpenSearchClient,
  OpenSearchRetrievalIndex,
} from '@chief-of-staff/rag/opensearch';
import { router } from '../trpc.js';
import { healthRouter } from './health.js';
import { createCommunicationsRouter } from './communications.js';
import { createAsanaRouter } from './asana.js';
import { createMetricsRouter } from './metrics.js';
import { createAccountsRouter } from './accounts.js';
import { ApprovalService } from '../services/approval-service.js';
import { AsanaService } from '../services/asana-service.js';
import { MetricsService } from '../services/metrics-service.js';
import { createStyleFeedbackHook } from '../services/style-feedback.js';
import type { StyleFeedbackHook } from '../services/style-feedback.js';
import { createCommunicationsRepo } from '../repos/communications-repo.js';
import { createAccountsRepo, type AccountsRepo } from '../repos/accounts-repo.js';
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
let cachedAsanaService: AsanaService | undefined;
let cachedMetricsService: MetricsService | undefined;
let cachedAccountsRepo: AccountsRepo | undefined;

function connectorFor(channelType: ChannelType): Connector | undefined {
  // Gmail is the only sendable channel wired today (design.md's Live tier — channel-access-tiers.md);
  // other channels return undefined, which `ApprovalService.approveDraft` turns into a clear
  // IllegalActionError rather than a crash.
  if (channelType === 'gmail') return createRealGmailConnector();
  return undefined;
}

/**
 * Task 10 feedback loop: `undefined` (not wired) unless BOTH `STYLE_PROFILES_TABLE_NAME` and
 * `RAG_DOMAIN_ENDPOINT` are set — same "degrade to no-op rather than a crash" posture every other
 * optional dependency in this module uses (`connectorFor` returning `undefined`, `agentTrigger`
 * falling back to `noopAgentTrigger`). `ApprovalService.approveDraft` treats an unwired hook as a
 * total no-op (see `feedBackStyleExemplarIsolated`'s doc comment).
 */
function styleFeedbackHook(): StyleFeedbackHook | undefined {
  if (!env.styleProfilesTableName || !env.ragDomainEndpoint) return undefined;
  return createStyleFeedbackHook({
    styleProfileRepo: createStyleProfileRepo(env.styleProfilesTableName),
    retrievalIndex: new OpenSearchRetrievalIndex(
      createSignedOpenSearchClient({ endpoint: env.ragDomainEndpoint, region: env.region }),
    ),
  });
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
      styleFeedbackHook: styleFeedbackHook(),
    });
  }
  return cachedApprovalService;
}

function asanaService(): AsanaService {
  if (!cachedAsanaService) {
    if (!env.communicationsTableName || !env.accountsTableName) {
      throw new Error('COMMUNICATIONS_TABLE_NAME and ACCOUNTS_TABLE_NAME must be set');
    }
    cachedAsanaService = new AsanaService({
      asanaClient: new AsanaClient(),
      communicationsRepo: createCommunicationsRepo(env.communicationsTableName),
      accountsRepo: createAccountsRepo(env.accountsTableName),
      log: logger,
      metricsClient: metrics,
    });
  }
  return cachedAsanaService;
}

function metricsService(): MetricsService {
  if (!cachedMetricsService) {
    if (!env.communicationsTableName || !env.accountsTableName) {
      throw new Error('COMMUNICATIONS_TABLE_NAME and ACCOUNTS_TABLE_NAME must be set');
    }
    cachedMetricsService = new MetricsService({
      communicationsRepo: createCommunicationsRepo(env.communicationsTableName),
      accountsRepo: createAccountsRepo(env.accountsTableName),
    });
  }
  return cachedMetricsService;
}

function accountsRepo(): AccountsRepo {
  if (!cachedAccountsRepo) {
    if (!env.accountsTableName) {
      throw new Error('ACCOUNTS_TABLE_NAME must be set');
    }
    cachedAccountsRepo = createAccountsRepo(env.accountsTableName);
  }
  return cachedAccountsRepo;
}

export const appRouter = router({
  health: healthRouter,
  communications: createCommunicationsRouter(() => approvalService()),
  asana: createAsanaRouter(() => asanaService()),
  metrics: createMetricsRouter(() => metricsService()),
  accounts: createAccountsRouter(() => accountsRepo()),
});

export type AppRouter = typeof appRouter;
