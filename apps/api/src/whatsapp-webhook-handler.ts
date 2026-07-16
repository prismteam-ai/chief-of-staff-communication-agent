import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import middy from '@middy/core';
import {
  createSignedOpenSearchClient,
  OpenSearchRetrievalIndex,
} from '@chief-of-staff/rag/opensearch';
import type { RetrievalIndex } from '@chief-of-staff/rag';
import { loadTwilioWhatsAppCredentials } from '@chief-of-staff/connectors/whatsapp';
import { createDedupeRepo } from './repos/dedupe-repo.js';
import { createCommunicationsRepo } from './repos/communications-repo.js';
import { createAgentTrigger, noopAgentTrigger } from './agent-trigger.js';
import { processInboundWhatsAppWebhook } from './whatsapp-inbound.js';
import { loadApiRuntimeEnv } from './env.js';
import { logger, metrics, tracer } from './context.js';

/**
 * API Gateway entry point for Twilio's inbound WhatsApp webhook (Task 9, brief constraint 3):
 * `POST /whatsapp/inbound`. A separate Lambda from the tRPC handler (`handler.ts`) — Twilio POSTs
 * `application/x-www-form-urlencoded`, not JSON-RPC, so this is a plain REST endpoint on the same
 * `HttpApi` (stable URL, design.md's "the endpoint path must be stable and documented" constraint).
 *
 * Always returns HTTP 200 with empty TwiML on success/duplicate/isolated-failure paths — Twilio
 * retries aggressively on non-2xx, and a retry of an already-claimed dedupe key is harmless (the
 * SECOND delivery just loses the claim and no-ops), so there is no benefit to signaling ingest
 * failures back to Twilio as a webhook-level error. Only a bad signature returns 403 (never retried
 * usefully — Twilio can't fix its own signature) and a request with no parseable body returns 400.
 */

const env = loadApiRuntimeEnv();

function requireEnv(): void {
  if (!env.communicationsTableName || !env.dedupeTableName) {
    throw new Error('COMMUNICATIONS_TABLE_NAME and DEDUPE_TABLE_NAME must be set');
  }
  if (!env.whatsappWebhookUrl) {
    throw new Error('WHATSAPP_WEBHOOK_URL must be set — required for Twilio signature verification');
  }
}

let cachedRetrievalIndex: OpenSearchRetrievalIndex | undefined;
function realRetrievalIndex(): OpenSearchRetrievalIndex {
  cachedRetrievalIndex ??= new OpenSearchRetrievalIndex(
    createSignedOpenSearchClient({ endpoint: env.ragDomainEndpoint, region: env.region }),
  );
  return cachedRetrievalIndex;
}

/** Same degrade-gracefully posture as `apps/ingest/src/processor-handler.ts`'s
 * `unwiredRetrievalIndex`: an unset RAG domain must never block ingestion. */
const unwiredRetrievalIndex: RetrievalIndex = {
  indexChunks: () => Promise.reject(new Error('RAG_DOMAIN_ENDPOINT not set')),
  search: () => Promise.reject(new Error('RAG_DOMAIN_ENDPOINT not set')),
  filterSearch: () => Promise.reject(new Error('RAG_DOMAIN_ENDPOINT not set')),
};

function retrievalIndex(): RetrievalIndex {
  return env.ragDomainEndpoint ? realRetrievalIndex() : unwiredRetrievalIndex;
}

/** API Gateway HTTP APIs (payload format 2.0) base64-encode a form-urlencoded body by default;
 * decode and parse into a flat string map the same shape Twilio's SDK receives server-side.
 * Exported for unit testing (same convention as `poller-handler.ts`'s `sendBatchWithRetry`). */
export function decodeFormBody(event: APIGatewayProxyEventV2): Record<string, string> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
  const params = new URLSearchParams(raw);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

/** API Gateway lower-cases every header name on the v2 event. */
export function getSignatureHeader(event: APIGatewayProxyEventV2): string | undefined {
  return event.headers?.['x-twilio-signature'];
}

const TWIML_EMPTY_RESPONSE =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

async function baseHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  requireEnv();

  const formParams = decodeFormBody(event);
  const signatureHeader = getSignatureHeader(event);

  const { auth_token } = await loadTwilioWhatsAppCredentials();

  const dedupeRepo = createDedupeRepo(env.dedupeTableName);
  const communicationsRepo = createCommunicationsRepo(env.communicationsTableName);
  const agentTrigger = env.agentQueueUrl ? createAgentTrigger(env.agentQueueUrl) : noopAgentTrigger;

  const result = await processInboundWhatsAppWebhook(formParams, signatureHeader, {
    authToken: auth_token,
    webhookUrl: env.whatsappWebhookUrl,
    dedupeRepo,
    communicationsRepo,
    retrievalIndex: retrievalIndex(),
    agentTrigger,
    log: logger,
    metricsClient: metrics,
  });

  if (result.outcome === 'unauthorized') {
    return { statusCode: 403, body: 'invalid signature' };
  }

  // 'ingested' | 'duplicate' | 'failed' all return 200 — see the module doc comment above for why.
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml' },
    body: TWIML_EMPTY_RESPONSE,
  };
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger, { logEvent: false }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics, { captureColdStartMetric: true }));
