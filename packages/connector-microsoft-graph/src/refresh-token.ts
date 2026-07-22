import type {
  OAuthCredentialState,
  RefreshClaim,
} from '@chief/contracts/connectors';

export interface GraphRefreshExchangeResult {
  readonly encryptedRefreshTokenRef: string;
  readonly tokenVersionDigest: string;
  readonly expiresAt?: string;
  readonly grantedScopes: readonly string[];
}

export interface GraphRefreshStateStore {
  load(tenantId: string, accountId: string): Promise<OAuthCredentialState>;
  claim(
    state: OAuthCredentialState,
    claim: RefreshClaim,
  ): Promise<'acquired' | 'contended'>;
  compareAndSwap(
    expected: OAuthCredentialState,
    next: OAuthCredentialState,
    claim: RefreshClaim,
  ): Promise<'committed' | 'stale'>;
  requireReauthorization(
    expected: OAuthCredentialState,
    claim: RefreshClaim,
    observedAt: string,
  ): Promise<void>;
}

export type GraphRefreshExchange = (
  encryptedRefreshTokenRef: string,
  claim: RefreshClaim,
) => Promise<GraphRefreshExchangeResult>;

export type GraphRefreshOutcome =
  | { readonly status: 'rotated'; readonly state: OAuthCredentialState }
  | { readonly status: 'contended'; readonly state: OAuthCredentialState }
  | { readonly status: 'superseded'; readonly state: OAuthCredentialState }
  | { readonly status: 'reauthorization_required' };

export async function rotateGraphRefreshToken(
  store: GraphRefreshStateStore,
  exchange: GraphRefreshExchange,
  claim: RefreshClaim,
  observedAt: string,
): Promise<GraphRefreshOutcome> {
  const current = await store.load(claim.tenantId, claim.accountId);
  assertClaimBindsState(current, claim);
  if (current.status !== 'active') {
    throw new Error('GRAPH_CREDENTIAL_NOT_ACTIVE');
  }
  const acquired = await store.claim(current, claim);
  if (acquired === 'contended') {
    return {
      status: 'contended',
      state: await store.load(claim.tenantId, claim.accountId),
    };
  }

  let exchanged: GraphRefreshExchangeResult;
  try {
    exchanged = await exchange(current.encryptedRefreshTokenRef, claim);
  } catch {
    throw new Error('GRAPH_REFRESH_EXCHANGE_FAILED');
  }
  const next: OAuthCredentialState = {
    ...current,
    encryptedRefreshTokenRef: exchanged.encryptedRefreshTokenRef,
    tokenVersionDigest: exchanged.tokenVersionDigest,
    scopes: [...exchanged.grantedScopes],
    credentialEpoch: current.credentialEpoch + 1,
    optimisticVersion: current.optimisticVersion + 1,
    status: 'active',
    expiresAt: exchanged.expiresAt,
    updatedAt: observedAt,
  };
  try {
    const result = await store.compareAndSwap(current, next, claim);
    if (result === 'stale') {
      return {
        status: 'superseded',
        state: await store.load(claim.tenantId, claim.accountId),
      };
    }
    return { status: 'rotated', state: next };
  } catch {
    await store.requireReauthorization(current, claim, observedAt);
    return { status: 'reauthorization_required' };
  }
}

function assertClaimBindsState(
  state: OAuthCredentialState,
  claim: RefreshClaim,
): void {
  if (
    state.tenantId !== claim.tenantId ||
    state.accountId !== claim.accountId ||
    state.credentialEpoch !== claim.credentialEpoch
  ) {
    throw new Error('GRAPH_REFRESH_CLAIM_BINDING_MISMATCH');
  }
}
