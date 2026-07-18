import { describe, expect, it } from 'vitest';
import type {
  RetrievalDeltaManifest,
  RetrievalQuery,
  RetrievalScope,
  RetrievalSnapshotManifest,
} from '@chief/contracts/knowledge';
import { retrievalArchitecture, type RetrievalIndex } from './index.js';

const compileTimeImplementation = {
  applySnapshot: (manifest: RetrievalSnapshotManifest) =>
    Promise.resolve({
      kind: 'snapshot' as const,
      tenantId: manifest.tenantId,
      scopeHash: manifest.scopeHash,
      role: manifest.role,
      generation: manifest.generation,
      authorizationEpoch: manifest.authorizationEpoch,
      manifestHash: manifest.manifestHash,
      appliedAt: manifest.createdAt,
    }),
  applyDelta: (manifest: RetrievalDeltaManifest) =>
    Promise.resolve({
      kind: 'delta' as const,
      tenantId: manifest.tenantId,
      scopeHash: manifest.scopeHash,
      role: manifest.role,
      baseGeneration: manifest.baseGeneration,
      authorizationEpoch: manifest.authorizationEpoch,
      sequenceEnd: manifest.sequenceEnd,
      manifestHash: manifest.manifestHash,
      appliedAt: manifest.createdAt,
    }),
  query: (_input: RetrievalQuery) => Promise.resolve([]),
  health: (scope: RetrievalScope) =>
    Promise.resolve({
      status: 'healthy' as const,
      scope,
      indexedChunkCount: 0,
      pendingDeltaCount: 0,
      observedAt: '2026-07-17T00:00:00.000Z',
    }),
} satisfies RetrievalIndex;

describe('retrieval boundary', () => {
  it('freezes the bounded authoritative production profile', () => {
    expect(retrievalArchitecture).toEqual({
      contractVersion: '1',
      authority: 'dynamodb',
      immutableProjectionStore: 's3-object-lock',
      exactLookup: 'bounded-entity-reference',
      lexicalAlgorithm: 'bm25',
      vectorAlgorithm: 'exhaustive-cosine',
      maximumExactEntityRefs: 100,
      maximumCandidates: 100,
      maximumSnapshotChunks: 10_000,
      warmStateRequired: false,
      tableScanAllowed: false,
      automaticPromotionTarget: 'dynamodb-s3-cas-head',
    });
    expect(Object.isFrozen(retrievalArchitecture)).toBe(true);
  });

  it('requires concrete snapshot, delta, query, and health methods', () => {
    expect(Object.keys(compileTimeImplementation).sort()).toEqual([
      'applyDelta',
      'applySnapshot',
      'health',
      'query',
    ]);
  });
});
