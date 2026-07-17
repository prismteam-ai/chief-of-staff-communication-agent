import type {
  ConnectorAccount,
  LeaseMutationClaim,
  OAuthCredentialState,
  RefreshClaim,
  SubscriptionLease,
  SyncCheckpoint,
  TenantId,
} from '@chief/contracts';

import {
  assertExpected,
  assertTenant,
  DomainInvariantError,
  immutable,
  instantMilliseconds,
} from './invariants.js';

type ConnectorAccountStatus = ConnectorAccount['status'];
type SubscriptionLeaseStatus = SubscriptionLease['status'];

const accountTransitions: Readonly<
  Record<ConnectorAccountStatus, readonly ConnectorAccountStatus[]>
> = {
  pending: ['active', 'disabled'],
  active: ['degraded', 'revoked', 'disabled'],
  degraded: ['active', 'revoked', 'disabled'],
  revoked: [],
  disabled: ['active', 'revoked'],
};

const leaseTransitions: Readonly<
  Record<SubscriptionLeaseStatus, readonly SubscriptionLeaseStatus[]>
> = {
  candidate: ['active', 'invalidated'],
  active: ['renewing', 'expired', 'invalidated', 'teardown_pending'],
  renewing: ['active', 'expired', 'invalidated', 'teardown_pending'],
  expired: ['candidate', 'invalidated', 'teardown_pending'],
  invalidated: ['teardown_pending'],
  teardown_pending: ['invalidated'],
};

export function transitionConnectorAccount(input: {
  readonly actorTenantId: TenantId;
  readonly account: ConnectorAccount;
  readonly expectedStateVersion: number;
  readonly nextStatus: ConnectorAccountStatus;
  readonly updatedAt: string;
}): Readonly<ConnectorAccount> {
  assertTenant(input.actorTenantId, input.account.tenantId);
  assertExpected(
    input.account.stateVersion,
    input.expectedStateVersion,
    'revision',
  );
  if (!accountTransitions[input.account.status].includes(input.nextStatus)) {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      `connector account cannot transition from ${input.account.status} to ${input.nextStatus}`,
    );
  }
  return immutable({
    ...input.account,
    status: input.nextStatus,
    stateVersion: input.account.stateVersion + 1,
    updatedAt: input.updatedAt,
  });
}

export function transitionSubscriptionLease(input: {
  readonly actorTenantId: TenantId;
  readonly lease: SubscriptionLease;
  readonly claim: LeaseMutationClaim;
  readonly expectedLeaseEpoch: number;
  readonly expectedMutationEpoch: number;
  readonly expectedClaimOwner: string;
  readonly expectedClaimRequestFingerprint: string;
  readonly expectedMutation: LeaseMutationClaim['mutation'];
  readonly nextStatus: SubscriptionLeaseStatus;
  readonly expiresAt?: string;
  readonly renewAfter?: string;
  readonly reconciledAt: string;
}): Readonly<SubscriptionLease> {
  assertTenant(input.actorTenantId, input.lease.tenantId);
  assertTenant(input.lease.tenantId, input.claim.tenantId);
  if (
    input.lease.accountId !== input.claim.accountId ||
    input.lease.resourceScopeHash !== input.claim.resourceScopeHash
  ) {
    throw new DomainInvariantError(
      'CROSS_TENANT_ACCESS',
      'lease mutation claim is not bound to this account and resource scope',
    );
  }
  assertExpected(input.lease.leaseEpoch, input.expectedLeaseEpoch, 'epoch');
  assertExpected(
    input.claim.mutationEpoch,
    input.expectedMutationEpoch,
    'epoch',
  );
  assertExpected(input.claim.leaseEpoch, input.lease.leaseEpoch, 'epoch');
  if (
    input.claim.owner !== input.expectedClaimOwner ||
    input.claim.requestFingerprint !== input.expectedClaimRequestFingerprint ||
    input.claim.mutation !== input.expectedMutation ||
    instantMilliseconds(input.claim.expiresAt) <=
      instantMilliseconds(input.reconciledAt)
  ) {
    throw new DomainInvariantError(
      'STALE_EPOCH',
      'lease mutation claim ownership is stale or expired',
    );
  }
  if (!leaseTransitions[input.lease.status].includes(input.nextStatus)) {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      `subscription lease cannot transition from ${input.lease.status} to ${input.nextStatus}`,
    );
  }
  return immutable({
    ...input.lease,
    status: input.nextStatus,
    leaseEpoch: input.lease.leaseEpoch + 1,
    optimisticVersion: input.lease.optimisticVersion + 1,
    expiresAt: input.expiresAt ?? input.lease.expiresAt,
    renewAfter: input.renewAfter ?? input.lease.renewAfter,
    lastReconciledAt: input.reconciledAt,
  });
}

export function rotateOAuthCredential(input: {
  readonly actorTenantId: TenantId;
  readonly credential: OAuthCredentialState;
  readonly claim: RefreshClaim;
  readonly expectedCredentialEpoch: number;
  readonly expectedOptimisticVersion: number;
  readonly expectedClaimOwner: string;
  readonly expectedClaimRequestFingerprint: string;
  readonly expectedRecoveryProfileVersion: string;
  readonly observedAt: string;
  readonly encryptedRefreshTokenRef: string;
  readonly tokenVersionDigest: string;
  readonly updatedAt: string;
}): Readonly<OAuthCredentialState> {
  assertTenant(input.actorTenantId, input.credential.tenantId);
  assertTenant(input.credential.tenantId, input.claim.tenantId);
  if (input.credential.accountId !== input.claim.accountId) {
    throw new DomainInvariantError(
      'CROSS_TENANT_ACCESS',
      'refresh claim is not bound to this connector account',
    );
  }
  assertExpected(
    input.credential.credentialEpoch,
    input.expectedCredentialEpoch,
    'epoch',
  );
  assertExpected(
    input.credential.optimisticVersion,
    input.expectedOptimisticVersion,
    'revision',
  );
  assertExpected(
    input.claim.credentialEpoch,
    input.credential.credentialEpoch,
    'epoch',
  );
  if (
    input.claim.owner !== input.expectedClaimOwner ||
    input.claim.requestFingerprint !== input.expectedClaimRequestFingerprint ||
    input.claim.recoveryProfileVersion !==
      input.expectedRecoveryProfileVersion ||
    instantMilliseconds(input.claim.expiresAt) <=
      instantMilliseconds(input.observedAt)
  ) {
    throw new DomainInvariantError(
      'STALE_EPOCH',
      'refresh claim ownership is stale or expired',
    );
  }
  if (input.credential.status === 'revoked') {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      'revoked OAuth credentials cannot rotate',
    );
  }
  return immutable({
    ...input.credential,
    encryptedRefreshTokenRef: input.encryptedRefreshTokenRef,
    tokenVersionDigest: input.tokenVersionDigest,
    credentialEpoch: input.credential.credentialEpoch + 1,
    optimisticVersion: input.credential.optimisticVersion + 1,
    status: 'active',
    updatedAt: input.updatedAt,
  });
}

export function advanceSyncCheckpoint(input: {
  readonly actorTenantId: TenantId;
  readonly checkpoint: SyncCheckpoint;
  readonly expectedCheckpointEpoch: number;
  readonly encryptedCursor: string;
  readonly sourceWatermark: string;
  readonly completePage: number;
  readonly canonicalWritesCommitted: boolean;
  readonly eventOutboxCommitted: boolean;
  readonly committedAt: string;
}): Readonly<SyncCheckpoint> {
  assertTenant(input.actorTenantId, input.checkpoint.tenantId);
  assertExpected(
    input.checkpoint.checkpointEpoch,
    input.expectedCheckpointEpoch,
    'epoch',
  );
  if (!input.canonicalWritesCommitted || !input.eventOutboxCommitted) {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      'checkpoint cannot advance before canonical writes and event outbox commit',
    );
  }
  if (input.completePage < input.checkpoint.lastCompletePage) {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      'checkpoint page cannot regress',
    );
  }
  return immutable({
    ...input.checkpoint,
    encryptedCursor: input.encryptedCursor,
    sourceWatermark: input.sourceWatermark,
    lastCompletePage: input.completePage,
    checkpointEpoch: input.checkpoint.checkpointEpoch + 1,
    committedAt: input.committedAt,
  });
}
