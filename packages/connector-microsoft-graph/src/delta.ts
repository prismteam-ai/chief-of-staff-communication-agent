import type { PollRequest, SyncPage } from '@chief/contracts/connectors';

import type { GraphDeltaResponse } from './graph-types.js';
import type { GraphNormalizationContext } from './normalization.js';
import { normalizeGraphMessage } from './normalization.js';
import { sha256 } from './hash.js';

export interface GraphDeltaTransport {
  poll(input: {
    readonly sealedCursor: string;
    readonly maxItems: number;
    readonly maxPages: number;
    readonly preferImmutableId: true;
  }): Promise<{
    readonly response: GraphDeltaResponse;
    readonly nextSealedCursor?: string;
  }>;
}

export interface GraphDeltaRecoveryTransport extends GraphDeltaTransport {
  restart(input: {
    readonly resourceScopeHash: string;
    readonly maxItems: number;
    readonly maxPages: number;
    readonly preferImmutableId: true;
  }): Promise<{
    readonly response: GraphDeltaResponse;
    readonly nextSealedCursor: string;
  }>;
}

export class GraphDeltaRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly providerCode?: string,
  ) {
    super('GRAPH_DELTA_REQUEST_FAILED');
    this.name = 'GraphDeltaRequestError';
  }
}

export type GraphDeltaRecovery =
  | { readonly action: 'retry'; readonly reason: 'rate_limited' | 'temporary' }
  | { readonly action: 'restart'; readonly reason: 'delta_token_expired' }
  | { readonly action: 'fail'; readonly reason: 'authorization' | 'malformed' };

export function classifyGraphDeltaFailure(
  status: number,
  code?: string,
): GraphDeltaRecovery {
  if (
    status === 410 ||
    status === 404 ||
    code === 'SyncStateNotFound' ||
    code === 'InvalidDeltaToken'
  ) {
    return { action: 'restart', reason: 'delta_token_expired' };
  }
  if (status === 429) {
    return { action: 'retry', reason: 'rate_limited' };
  }
  if (status >= 500) {
    return { action: 'retry', reason: 'temporary' };
  }
  if (status === 401 || status === 403) {
    return { action: 'fail', reason: 'authorization' };
  }
  return { action: 'fail', reason: 'malformed' };
}

export async function pollGraphDelta(
  transport: GraphDeltaTransport,
  request: PollRequest,
  context: GraphNormalizationContext,
): Promise<SyncPage> {
  if (request.checkpoint.kind !== 'delta') {
    throw new Error('GRAPH_DELTA_CHECKPOINT_REQUIRED');
  }
  const result = await transport.poll({
    sealedCursor: request.checkpoint.encryptedCursor,
    maxItems: request.maxItems,
    maxPages: request.maxPages,
    preferImmutableId: true,
  });
  const active = result.response.value.filter(
    (message) => message['@removed'] === undefined,
  );
  if (active.length > request.maxItems) {
    throw new Error('GRAPH_DELTA_PAGE_BUDGET_EXCEEDED');
  }
  const envelopes = active.map(
    (message) => normalizeGraphMessage(message, context).envelope,
  );
  const hasNext = result.response['@odata.nextLink'] !== undefined;
  const hasDelta = result.response['@odata.deltaLink'] !== undefined;
  if ((hasNext || hasDelta) && result.nextSealedCursor === undefined) {
    throw new Error('GRAPH_DELTA_CURSOR_NOT_SEALED');
  }
  if (!hasNext && !hasDelta) {
    throw new Error('GRAPH_DELTA_TERMINAL_LINK_MISSING');
  }
  return {
    envelopes,
    ...(result.nextSealedCursor === undefined
      ? {}
      : { nextEncryptedCursor: result.nextSealedCursor }),
    sourceWatermark:
      result.response['@odata.deltaLink'] === undefined
        ? `page:${request.checkpoint.lastCompletePage + 1}`
        : `delta:${sha256(result.response['@odata.deltaLink'])}`,
    complete: hasDelta && !hasNext,
    providerResponseHash: sha256(JSON.stringify(result.response)),
  };
}

export async function pollGraphDeltaWithResetRecovery(
  transport: GraphDeltaRecoveryTransport,
  request: PollRequest,
  context: GraphNormalizationContext,
): Promise<SyncPage> {
  try {
    return await pollGraphDelta(transport, request, context);
  } catch (error) {
    if (!(error instanceof GraphDeltaRequestError)) {
      throw error;
    }
    const decision = classifyGraphDeltaFailure(
      error.status,
      error.providerCode,
    );
    if (decision.action !== 'restart') {
      throw error;
    }
    const restarted = await transport.restart({
      resourceScopeHash: request.resourceScopeHash,
      maxItems: request.maxItems,
      maxPages: request.maxPages,
      preferImmutableId: true,
    });
    return pollGraphDelta(
      {
        poll: () => Promise.resolve(restarted),
      },
      request,
      context,
    );
  }
}
