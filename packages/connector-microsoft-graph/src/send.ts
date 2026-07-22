import type {
  EffectExecutionArtifact,
  ProviderSendResult,
  ReconcileSendRequest,
} from '@chief/contracts/approval';

import { sha256 } from './hash.js';

export const GRAPH_RECONCILIATION_STRATEGY = 'graph-draft-sent-items';
export const GRAPH_RECONCILIATION_STRATEGY_VERSION = '1';

export interface GraphDraftSendResponse {
  readonly status: number;
  readonly requestId?: string;
  readonly responseBody?: string;
  readonly observedAt: string;
}

export interface GraphSentItemMatch {
  readonly immutableMessageId: string;
  readonly immutableDraftId: string;
  readonly observedAt: string;
}

export interface GraphDraftTransport {
  sendPreboundDraft(input: {
    readonly immutableDraftId: string;
    readonly operationId: string;
    readonly renderedPayloadFingerprint: string;
    readonly preferImmutableId: true;
  }): Promise<GraphDraftSendResponse>;
  findSentItem(input: {
    readonly immutableDraftId: string;
    readonly operationId: string;
    readonly maxQueries: number;
    readonly preferImmutableId: true;
  }): Promise<GraphSentItemMatch | undefined>;
}

export async function dispatchGraphPreboundDraft(
  artifact: EffectExecutionArtifact,
  transport: GraphDraftTransport,
): Promise<ProviderSendResult> {
  assertPreboundDraftArtifact(artifact);
  let response: GraphDraftSendResponse;
  try {
    response = await transport.sendPreboundDraft({
      immutableDraftId: artifact.clientCorrelation.value,
      operationId: artifact.operationId,
      renderedPayloadFingerprint: artifact.renderedPayloadFingerprint,
      preferImmutableId: true,
    });
  } catch {
    return {
      outcome: 'acceptance_unknown',
      reasonCode: 'graph_send_draft_transport_ambiguous',
      observedAt: new Date(0).toISOString(),
    };
  }
  const providerResponseHash = sha256(
    JSON.stringify({
      status: response.status,
      requestId: response.requestId ?? null,
      responseBody: response.responseBody ?? null,
    }),
  );
  if (response.status === 202) {
    return {
      outcome: 'accepted',
      providerResponseHash,
      providerCorrelation: artifact.clientCorrelation.value,
      observedAt: response.observedAt,
    };
  }
  if (response.status >= 400 && response.status < 500) {
    return {
      outcome: 'rejected',
      providerResponseHash,
      reasonCode: `graph_send_draft_http_${response.status}`,
      observedAt: response.observedAt,
    };
  }
  return {
    outcome: 'acceptance_unknown',
    providerResponseHash,
    reasonCode: `graph_send_draft_inconclusive_http_${response.status}`,
    observedAt: response.observedAt,
  };
}

export async function reconcileGraphPreboundDraft(
  request: ReconcileSendRequest,
  transport: GraphDraftTransport,
): Promise<ProviderSendResult> {
  assertPreboundDraftArtifact(request.artifact);
  if (
    request.strategy !== GRAPH_RECONCILIATION_STRATEGY ||
    request.strategyVersion !== GRAPH_RECONCILIATION_STRATEGY_VERSION
  ) {
    throw new Error('GRAPH_RECONCILIATION_STRATEGY_MISMATCH');
  }
  const match = await transport.findSentItem({
    immutableDraftId: request.artifact.clientCorrelation.value,
    operationId: request.artifact.operationId,
    maxQueries: request.maxProviderQueries,
    preferImmutableId: true,
  });
  if (match === undefined) {
    return {
      outcome: 'acceptance_unknown',
      reasonCode: 'graph_sent_item_not_proven_within_bound',
      observedAt: new Date(0).toISOString(),
    };
  }
  if (match.immutableDraftId !== request.artifact.clientCorrelation.value) {
    throw new Error('GRAPH_SENT_ITEM_DRAFT_BINDING_MISMATCH');
  }
  return {
    outcome: 'accepted',
    providerResponseHash: sha256(JSON.stringify(match)),
    providerCorrelation: match.immutableMessageId,
    observedAt: match.observedAt,
  };
}

export function assertPreboundDraftArtifact(
  artifact: EffectExecutionArtifact,
): void {
  if (artifact.clientCorrelation.kind !== 'provider_draft_id') {
    throw new Error('GRAPH_BARE_SENDMAIL_FORBIDDEN');
  }
  if (
    artifact.reconciliationStrategy !== GRAPH_RECONCILIATION_STRATEGY ||
    artifact.reconciliationStrategyVersion !==
      GRAPH_RECONCILIATION_STRATEGY_VERSION
  ) {
    throw new Error('GRAPH_PREBOUND_RECONCILIATION_IDENTITY_REQUIRED');
  }
  if (artifact.correlationBindingVersion !== '1') {
    throw new Error('GRAPH_CORRELATION_BINDING_VERSION_UNSUPPORTED');
  }
}
