import { describe, expect, it } from 'vitest';
import {
  oauthCredentialStateSchema,
  refreshClaimSchema,
  type OAuthCredentialState,
  type RefreshClaim,
} from '@chief/contracts/connectors';

import {
  rotateGraphRefreshToken,
  type GraphRefreshStateStore,
} from './refresh-token.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function credential(): OAuthCredentialState {
  return oauthCredentialStateSchema.parse({
    schemaVersion: '1',
    tenantId: 'tenant-a',
    accountId: 'account-a',
    providerSubjectDigest: 'h1_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    encryptedRefreshTokenRef: 'kms://ciphertext/epoch-1',
    envelopeVersion: '1',
    credentialEpoch: 1,
    optimisticVersion: 1,
    audience: 'https://graph.microsoft.com/',
    scopes: ['offline_access', 'User.Read', 'Mail.Read', 'Mail.Send'],
    tokenVersionDigest: HASH_A,
    status: 'active',
    updatedAt: '2026-07-17T12:00:00.000Z',
  });
}

function claim(): RefreshClaim {
  return refreshClaimSchema.parse({
    tenantId: 'tenant-a',
    accountId: 'account-a',
    credentialEpoch: 1,
    claimEpoch: 1,
    requestFingerprint: HASH_A,
    owner: 'worker-a',
    expiresAt: '2026-07-17T13:00:00.000Z',
    recoveryProfileVersion: '1',
  });
}

class Store implements GraphRefreshStateStore {
  public current = credential();
  public claimResult: 'acquired' | 'contended' = 'acquired';
  public casResult: 'committed' | 'stale' = 'committed';
  public failCas = false;
  public reauthorizationCount = 0;

  public load() {
    return Promise.resolve(this.current);
  }

  public claim(_state: OAuthCredentialState, _claim: RefreshClaim) {
    return Promise.resolve(this.claimResult);
  }

  public compareAndSwap(
    _expected: OAuthCredentialState,
    next: OAuthCredentialState,
    _claim: RefreshClaim,
  ) {
    if (this.failCas) {
      return Promise.reject(new Error('persistence unavailable'));
    }
    if (this.casResult === 'committed') {
      this.current = next;
    }
    return Promise.resolve(this.casResult);
  }

  public requireReauthorization() {
    this.reauthorizationCount += 1;
    return Promise.resolve();
  }
}

describe('Microsoft Graph rotating refresh-token fencing', () => {
  it('commits a rotated token only through epoch/version CAS', async () => {
    const store = new Store();
    const result = await rotateGraphRefreshToken(
      store,
      () =>
        Promise.resolve({
          encryptedRefreshTokenRef: 'kms://ciphertext/epoch-2',
          tokenVersionDigest: HASH_B,
          grantedScopes: [
            'offline_access',
            'User.Read',
            'Mail.Read',
            'Mail.Send',
          ],
        }),
      claim(),
      '2026-07-17T12:30:00.000Z',
    );
    expect(result.status).toBe('rotated');
    expect(store.current.credentialEpoch).toBe(2);
    expect(store.current.optimisticVersion).toBe(2);
    expect(store.current.encryptedRefreshTokenRef).toBe(
      'kms://ciphertext/epoch-2',
    );
  });

  it('does not exchange when another worker owns the fenced refresh claim', async () => {
    const store = new Store();
    store.claimResult = 'contended';
    let exchangeCount = 0;
    const result = await rotateGraphRefreshToken(
      store,
      () => {
        exchangeCount += 1;
        return Promise.reject(new Error('must not execute'));
      },
      claim(),
      '2026-07-17T12:30:00.000Z',
    );
    expect(result.status).toBe('contended');
    expect(exchangeCount).toBe(0);
  });

  it('fails closed to reauthorization after exchange succeeds but CAS persistence fails', async () => {
    const store = new Store();
    store.failCas = true;
    const result = await rotateGraphRefreshToken(
      store,
      () =>
        Promise.resolve({
          encryptedRefreshTokenRef: 'kms://ciphertext/epoch-2',
          tokenVersionDigest: HASH_B,
          grantedScopes: [
            'offline_access',
            'User.Read',
            'Mail.Read',
            'Mail.Send',
          ],
        }),
      claim(),
      '2026-07-17T12:30:00.000Z',
    );
    expect(result.status).toBe('reauthorization_required');
    expect(store.current.credentialEpoch).toBe(1);
    expect(store.reauthorizationCount).toBe(1);
  });
});
