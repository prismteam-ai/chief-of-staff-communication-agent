import type {
  EffectExecutionArtifact,
  ProviderSendResult,
  ReconcileSendRequest,
} from '@chief/contracts/approval';
import type { ConnectorAccountRef } from '@chief/contracts/connectors';

import type {
  GmailPreparedSendResultAccepted,
  GmailSendClient,
} from './types.js';

export const GMAIL_RECONCILIATION_STRATEGY = 'gmail_sent_rfc_message_id';
export const GMAIL_RECONCILIATION_VERSION = '1';

export function gmailProviderCorrelation(
  result: GmailPreparedSendResultAccepted,
): string {
  return `gmail:message:${result.providerMessageId}:thread:${result.providerThreadId}`;
}

function assertArtifact(artifact: EffectExecutionArtifact): void {
  if (
    artifact.clientCorrelation.kind !== 'rfc_message_id' ||
    !artifact.clientCorrelation.value.startsWith('<') ||
    !artifact.clientCorrelation.value.endsWith('>') ||
    artifact.correlationBindingVersion !== '1' ||
    artifact.reconciliationStrategy !== GMAIL_RECONCILIATION_STRATEGY ||
    artifact.reconciliationStrategyVersion !== GMAIL_RECONCILIATION_VERSION
  ) {
    throw new Error('GMAIL_CLIENT_CORRELATION_NOT_PREBOUND');
  }
}

export async function sendGmailEffect(
  client: GmailSendClient,
  account: ConnectorAccountRef,
  artifact: EffectExecutionArtifact,
): Promise<ProviderSendResult> {
  assertArtifact(artifact);
  const result = await client.sendPrepared(account, artifact);
  if (result.outcome !== 'accepted') {
    return result;
  }
  if (
    result.providerMessageId.length === 0 ||
    result.providerThreadId.length === 0
  ) {
    return {
      outcome: 'acceptance_unknown',
      providerResponseHash: result.providerResponseHash,
      reasonCode: 'gmail_acceptance_missing_message_or_thread_correlation',
      observedAt: result.observedAt,
    };
  }
  return {
    outcome: 'accepted',
    providerResponseHash: result.providerResponseHash,
    providerCorrelation: gmailProviderCorrelation(result),
    observedAt: result.observedAt,
  };
}

export async function reconcileGmailEffect(
  client: GmailSendClient,
  account: ConnectorAccountRef,
  request: ReconcileSendRequest,
): Promise<ProviderSendResult> {
  assertArtifact(request.artifact);
  if (
    request.priorAttemptId !== request.artifact.attemptId ||
    request.strategy !== GMAIL_RECONCILIATION_STRATEGY ||
    request.strategyVersion !== GMAIL_RECONCILIATION_VERSION
  ) {
    throw new Error('GMAIL_RECONCILIATION_BINDING_REJECTED');
  }
  const matches = await client.findSentByClientCorrelation({
    account,
    artifact: request.artifact,
    maxProviderQueries: request.maxProviderQueries,
  });
  if (matches.length !== 1) {
    return {
      outcome: 'acceptance_unknown',
      reasonCode:
        matches.length === 0
          ? 'gmail_sent_match_not_found_within_bound'
          : 'gmail_sent_match_ambiguous',
      observedAt: new Date(
        Date.parse(request.artifact.createdAt),
      ).toISOString(),
    };
  }
  const match = matches[0];
  if (match === undefined) {
    throw new Error('GMAIL_RECONCILIATION_MATCH_INVARIANT');
  }
  return {
    outcome: 'accepted',
    providerResponseHash: match.providerResponseHash,
    providerCorrelation: gmailProviderCorrelation(match),
    observedAt: match.observedAt,
  };
}
