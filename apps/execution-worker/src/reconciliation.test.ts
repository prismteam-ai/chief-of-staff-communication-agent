import { effectExecutionArtifactSchema } from '@chief/contracts/approval';
import type {
  CommunicationConnector,
  WorkManagementConnector,
} from '@chief/connector-core';
import { describe, expect, it, vi } from 'vitest';

import type { EffectConnectorSelector } from './provider-execution.js';
import {
  reconcileFrozenEffect,
  type FrozenEffectForReconciliation,
  type ReconciliationPersistence,
  type ResolverClaim,
} from './reconciliation.js';

const NOW = '2026-07-17T12:10:00.000Z';
const artifact = effectExecutionArtifactSchema.parse({
  schemaVersion: '1',
  tenantId: 'tenant-redwood',
  operationId: 'operation-send-001',
  attemptId: 'attempt-send-001',
  stableIdempotencyKey: 'stable-operation-send-001',
  account: {
    tenantId: 'tenant-redwood',
    accountId: 'account-gmail-001',
    expectedStateVersion: 11,
  },
  sourceMessageRevisionId: 'message-revision-001',
  actionPlanId: 'action-plan-001',
  actionPlanHash: 'a'.repeat(64),
  approvalId: 'approval-001',
  draftRevisionId: 'draft-revision-001',
  renderedPayloadFingerprint: 'b'.repeat(64),
  connectorSnapshot: {
    connectorId: 'gmail',
    descriptorVersion: 'gmail-2026-07',
    accountId: 'account-gmail-001',
    capabilitySnapshotHash: 'c'.repeat(64),
    runtimeMode: 'live',
    selectionState: 'selected',
  },
  clientCorrelation: {
    kind: 'rfc_message_id',
    value: '<chief-operation-send-001@example.test>',
  },
  correlationBindingVersion: 'correlation-v1',
  reconciliationStrategy: 'gmail_sent_rfc_message_id',
  reconciliationStrategyVersion: '1',
  createdAt: '2026-07-17T12:05:00.000Z',
});

class MemoryReconciliation implements ReconciliationPersistence {
  public resolver: ResolverClaim | undefined;
  public resolved = false;
  public epoch = 0;
  public settlement: string | undefined;
  public readonly frozen: FrozenEffectForReconciliation = {
    kind: 'communication',
    artifact,
    reasonCode: 'provider_timeout',
  };

  public claimResolver(input: {
    readonly operationId: typeof artifact.operationId;
    readonly owner: string;
  }): Promise<
    | { readonly status: 'claimed'; readonly claim: ResolverClaim }
    | { readonly status: 'contended' | 'resolved' | 'not_frozen' }
  > {
    if (this.resolved) return Promise.resolve({ status: 'resolved' });
    if (this.resolver !== undefined)
      return Promise.resolve({ status: 'contended' });
    this.epoch += 1;
    this.resolver = {
      operationId: input.operationId,
      owner: input.owner,
      resolverEpoch: this.epoch,
    };
    return Promise.resolve({ status: 'claimed', claim: this.resolver });
  }

  public loadFrozenEffect(claim: ResolverClaim) {
    this.assertClaim(claim);
    return Promise.resolve(this.frozen);
  }

  public settleReconciledAcceptance(claim: ResolverClaim): Promise<void> {
    this.finish(claim, 'accepted');
    return Promise.resolve();
  }

  public permitIdenticalRetry(claim: ResolverClaim): Promise<void> {
    this.finish(claim, 'retry_identical');
    return Promise.resolve();
  }

  public remainFrozen(claim: ResolverClaim): Promise<void> {
    this.finish(claim, 'remain_frozen');
    return Promise.resolve();
  }

  public releaseResolver(claim: ResolverClaim): Promise<void> {
    this.assertClaim(claim);
    this.resolver = undefined;
    return Promise.resolve();
  }

  private finish(claim: ResolverClaim, settlement: string): void {
    this.assertClaim(claim);
    this.settlement = settlement;
    this.resolved = true;
    this.resolver = undefined;
  }

  private assertClaim(claim: ResolverClaim): void {
    if (
      this.resolver?.owner !== claim.owner ||
      this.resolver.resolverEpoch !== claim.resolverEpoch
    ) {
      throw new Error('STALE_RESOLVER_EPOCH');
    }
  }
}

function connectorSelector(
  reconcile: CommunicationConnector['reconcileSend'],
): EffectConnectorSelector {
  return {
    communication: () =>
      ({
        descriptor: () => ({
          connectorId: 'gmail',
          descriptorVersion: 'gmail-2026-07',
        }),
        reconcileSend: reconcile,
      }) as unknown as CommunicationConnector,
    workManagement: () => ({}) as WorkManagementConnector,
  };
}

describe('acceptance reconciliation', () => {
  it('allows exactly one of two resolvers to query the provider', async () => {
    const persistence = new MemoryReconciliation();
    let releaseQuery: (() => void) | undefined;
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const reconcile = vi.fn(async () => {
      await queryGate;
      return {
        outcome: 'accepted' as const,
        providerResponseHash: 'd'.repeat(64),
        providerCorrelation: 'gmail-message-001',
        observedAt: NOW,
      };
    });
    const input = {
      persistence,
      connectors: connectorSelector(reconcile),
      operationId: artifact.operationId,
      observedAt: NOW,
      maxProviderQueries: 2,
    };
    const first = reconcileFrozenEffect({ ...input, resolverId: 'resolver-a' });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    const second = await reconcileFrozenEffect({
      ...input,
      resolverId: 'resolver-b',
    });
    releaseQuery?.();

    await expect(first).resolves.toMatchObject({ status: 'settled_accepted' });
    expect(second).toEqual({ status: 'contended' });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('permits only an identical retry after proven non-acceptance', async () => {
    const persistence = new MemoryReconciliation();
    const reconcile = vi.fn(() =>
      Promise.resolve({
        outcome: 'rejected' as const,
        providerResponseHash: 'e'.repeat(64),
        reasonCode: 'sent_search_proved_absent',
        observedAt: NOW,
      }),
    );
    await expect(
      reconcileFrozenEffect({
        persistence,
        connectors: connectorSelector(reconcile),
        operationId: artifact.operationId,
        resolverId: 'resolver-a',
        observedAt: NOW,
        maxProviderQueries: 2,
      }),
    ).resolves.toMatchObject({ status: 'retry_identical_operation' });
    expect(persistence.settlement).toBe('retry_identical');
  });

  it('keeps unresolved acceptance frozen without an ordinary retry', async () => {
    const persistence = new MemoryReconciliation();
    const reconcile = vi.fn(() =>
      Promise.resolve({
        outcome: 'acceptance_unknown' as const,
        providerResponseHash: 'f'.repeat(64),
        reasonCode: 'sent_search_inconclusive',
        observedAt: NOW,
      }),
    );
    await expect(
      reconcileFrozenEffect({
        persistence,
        connectors: connectorSelector(reconcile),
        operationId: artifact.operationId,
        resolverId: 'resolver-a',
        observedAt: NOW,
        maxProviderQueries: 2,
      }),
    ).resolves.toMatchObject({ status: 'remain_frozen' });
    expect(persistence.settlement).toBe('remain_frozen');
  });
});
