import type {
  RetrievalCandidate,
  RetrievalDeltaManifest,
  RetrievalQuery,
  RetrievalScope,
  RetrievalSnapshotManifest,
} from '@chief/contracts/knowledge';

export interface RetrievalSnapshotApplyResult {
  readonly kind: 'snapshot';
  readonly tenantId: string;
  readonly scopeHash: string;
  readonly role: RetrievalScope['role'];
  readonly generation: number;
  readonly authorizationEpoch: number;
  readonly manifestHash: string;
  readonly appliedAt: string;
}

export interface RetrievalDeltaApplyResult {
  readonly kind: 'delta';
  readonly tenantId: string;
  readonly scopeHash: string;
  readonly role: RetrievalScope['role'];
  readonly baseGeneration: number;
  readonly authorizationEpoch: number;
  readonly sequenceEnd: number;
  readonly manifestHash: string;
  readonly appliedAt: string;
}

export interface RetrievalHealthResult {
  readonly status: 'healthy' | 'degraded' | 'unavailable';
  readonly scope: RetrievalScope;
  readonly activeGeneration?: number;
  readonly authorizationEpoch?: number;
  readonly indexedChunkCount: number;
  readonly pendingDeltaCount: number;
  readonly observedAt: string;
  readonly reasonCode?: string;
}

/**
 * Stable bounded retrieval boundary. Implementations may promote from the
 * authoritative DynamoDB/S3 profile to OpenSearch without changing callers.
 */
export interface RetrievalIndex {
  applySnapshot(
    manifest: RetrievalSnapshotManifest,
  ): Promise<RetrievalSnapshotApplyResult>;
  applyDelta(
    manifest: RetrievalDeltaManifest,
  ): Promise<RetrievalDeltaApplyResult>;
  query(input: RetrievalQuery): Promise<readonly RetrievalCandidate[]>;
  health(scope: RetrievalScope): Promise<RetrievalHealthResult>;
}

export const retrievalArchitecture = Object.freeze({
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
} as const);

export * from './bounded-retrieval.js';
export * from './durable-retrieval.js';
export * from './aws-durable-retrieval.js';
