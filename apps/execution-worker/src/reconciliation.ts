import type {
  EffectExecutionArtifact,
  ProviderSendResult,
  ReconcileSendRequest,
} from '@chief/contracts/approval';
import { providerSendResultSchema } from '@chief/contracts/approval';

import type { ControlledEffectKind } from './runtime-policy.js';
import type { EffectConnectorSelector } from './provider-execution.js';

export interface FrozenEffectForReconciliation {
  readonly kind: ControlledEffectKind;
  readonly artifact: EffectExecutionArtifact;
  readonly reasonCode: string;
}

export interface ResolverClaim {
  readonly operationId: EffectExecutionArtifact['operationId'];
  readonly owner: string;
  readonly resolverEpoch: number;
}

export interface ReconciliationPersistence {
  claimResolver(input: {
    readonly operationId: EffectExecutionArtifact['operationId'];
    readonly owner: string;
    readonly observedAt: string;
  }): Promise<
    | { readonly status: 'claimed'; readonly claim: ResolverClaim }
    | { readonly status: 'contended' | 'resolved' | 'not_frozen' }
  >;
  loadFrozenEffect(
    claim: ResolverClaim,
  ): Promise<FrozenEffectForReconciliation | undefined>;
  settleReconciledAcceptance(
    claim: ResolverClaim,
    result: Extract<ProviderSendResult, { readonly outcome: 'accepted' }>,
  ): Promise<void>;
  permitIdenticalRetry(
    claim: ResolverClaim,
    result: Extract<ProviderSendResult, { readonly outcome: 'rejected' }>,
  ): Promise<void>;
  remainFrozen(
    claim: ResolverClaim,
    result: Extract<
      ProviderSendResult,
      { readonly outcome: 'acceptance_unknown' }
    >,
  ): Promise<void>;
  releaseResolver(claim: ResolverClaim): Promise<void>;
}

export type ReconciliationResult =
  | { readonly status: 'contended' | 'resolved' | 'not_frozen' }
  | {
      readonly status:
        'settled_accepted' | 'retry_identical_operation' | 'remain_frozen';
      readonly providerResult: ProviderSendResult;
    };

export async function reconcileFrozenEffect(input: {
  readonly persistence: ReconciliationPersistence;
  readonly connectors: EffectConnectorSelector;
  readonly operationId: EffectExecutionArtifact['operationId'];
  readonly resolverId: string;
  readonly observedAt: string;
  readonly maxProviderQueries: number;
}): Promise<ReconciliationResult> {
  if (
    !Number.isSafeInteger(input.maxProviderQueries) ||
    input.maxProviderQueries < 1 ||
    input.maxProviderQueries > 10
  ) {
    throw new Error('INVALID_RECONCILIATION_QUERY_BUDGET');
  }
  const claimed = await input.persistence.claimResolver({
    operationId: input.operationId,
    owner: input.resolverId,
    observedAt: input.observedAt,
  });
  if (claimed.status !== 'claimed') return { status: claimed.status };
  const claim = claimed.claim;
  const frozen = await input.persistence.loadFrozenEffect(claim);
  if (frozen === undefined) {
    await input.persistence.releaseResolver(claim);
    return { status: 'not_frozen' };
  }
  if (frozen.artifact.operationId !== claim.operationId) {
    await input.persistence.releaseResolver(claim);
    throw new Error('RECONCILIATION_OPERATION_BINDING_MISMATCH');
  }

  let result: ProviderSendResult;
  try {
    if (frozen.kind === 'communication') {
      const connector = input.connectors.communication(
        frozen.artifact.connectorSnapshot.connectorId,
      );
      const descriptor = connector.descriptor();
      if (
        connector.reconcileSend === undefined ||
        descriptor.connectorId !==
          frozen.artifact.connectorSnapshot.connectorId ||
        descriptor.descriptorVersion !==
          frozen.artifact.connectorSnapshot.descriptorVersion
      ) {
        throw new Error('COMMUNICATION_RECONCILIATION_UNAVAILABLE');
      }
      const request: ReconcileSendRequest = {
        schemaVersion: '1',
        artifact: frozen.artifact,
        priorAttemptId: frozen.artifact.attemptId,
        strategy: frozen.artifact.reconciliationStrategy,
        strategyVersion: frozen.artifact.reconciliationStrategyVersion,
        maxProviderQueries: input.maxProviderQueries,
      };
      result = providerSendResultSchema.parse(
        await connector.reconcileSend(frozen.artifact.account, request),
      );
    } else {
      const connector = input.connectors.workManagement(
        frozen.artifact.connectorSnapshot.connectorId,
      );
      const descriptor = connector.descriptor();
      if (
        connector.reconcileEffect === undefined ||
        descriptor.connectorId !==
          frozen.artifact.connectorSnapshot.connectorId ||
        descriptor.descriptorVersion !==
          frozen.artifact.connectorSnapshot.descriptorVersion
      ) {
        throw new Error('WORK_MANAGEMENT_RECONCILIATION_UNAVAILABLE');
      }
      result = providerSendResultSchema.parse(
        await connector.reconcileEffect(
          frozen.artifact.account,
          frozen.artifact,
        ),
      );
    }
  } catch (error) {
    await input.persistence.releaseResolver(claim);
    throw error;
  }

  if (result.outcome === 'accepted') {
    await input.persistence.settleReconciledAcceptance(claim, result);
    return { status: 'settled_accepted', providerResult: result };
  }
  if (result.outcome === 'rejected') {
    await input.persistence.permitIdenticalRetry(claim, result);
    return { status: 'retry_identical_operation', providerResult: result };
  }
  await input.persistence.remainFrozen(claim, result);
  return { status: 'remain_frozen', providerResult: result };
}
