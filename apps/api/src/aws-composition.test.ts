import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import {
  DeterministicEffectDisabledEmbedding,
  prepareEffectDisabledQueryVector,
  type AuthorizedRetrievalResult,
  type InProcessQueryVector,
} from '@chief/rag';
import {
  citationSchema,
  deterministicEvaluatorIdentityV2,
  retrievalCandidateSchema,
  type RetrievalQuery,
} from '@chief/contracts';

import {
  createDurableRequestContext,
  createReadOnlyAwsRetrieval,
} from './aws-composition.js';
import type { DurableManifestBinding } from './durable-product-service.js';

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('AWS durable API composition', () => {
  it('derives the durable request scope from the shared evaluator identity', () => {
    const context = createDurableRequestContext();
    expect(context.actor).toMatchObject({
      tenantId: deterministicEvaluatorIdentityV2.tenantId,
      userId: deterministicEvaluatorIdentityV2.userId,
      accountScopes: deterministicEvaluatorIdentityV2.accountIds,
      brandScopes: deterministicEvaluatorIdentityV2.brandIds,
    });
    expect(context.retrievalScope).toEqual({
      derivation: 'server_grants',
      tenantId: deterministicEvaluatorIdentityV2.tenantId,
      accountIds: deterministicEvaluatorIdentityV2.accountIds,
      brandIds: deterministicEvaluatorIdentityV2.brandIds,
      authorizationEpoch: deterministicEvaluatorIdentityV2.authorizationEpoch,
      scopeHash: deterministicEvaluatorIdentityV2.scopeHash,
    });
  });

  it('prepares query vectors in process and keeps the retrieval path read-only', async () => {
    const producer = new DeterministicEffectDisabledEmbedding();
    let persistedPrepareCalls = 0;
    let observed:
      | {
          readonly query: RetrievalQuery;
          readonly prepared: InProcessQueryVector;
        }
      | undefined;
    const result: AuthorizedRetrievalResult = {
      candidates: [],
      citations: [],
      abstained: true,
      authorizationEpoch: 1,
      snapshotManifestHash:
        'b591109c0ddfc4a602f56768cbbd7df2eb9606f7d45dc986cf5ca6f914dca4f1',
      scoringProfileVersion: 'chief-bounded-fusion-v1',
      evidence: [],
    };
    const runtime = {
      queryVectors: {
        prepare: () => {
          persistedPrepareCalls += 1;
          throw new Error('DYNAMODB_WRITE_ATTEMPTED');
        },
        prepareInProcess: (queryText: string) =>
          prepareEffectDisabledQueryVector({ producer, queryText }),
      },
      index: {
        queryWithCitations: (
          query: RetrievalQuery,
          prepared: InProcessQueryVector,
        ) => {
          observed = { query, prepared };
          return Promise.resolve(result);
        },
        inspect: () =>
          Promise.resolve({
            status: 'ready' as const,
            authorizationEpoch: result.authorizationEpoch,
            manifestHash: result.snapshotManifestHash,
          }),
      },
    };
    const retrieval = createReadOnlyAwsRetrieval(runtime);

    await expect(
      retrieval.search(createDurableRequestContext(), {
        queryText: 'What is the launch decision?',
        exactEntityRefs: ['thread:launch-decision'],
        limit: 5,
      }),
    ).resolves.toBe(result);

    expect(persistedPrepareCalls).toBe(0);
    expect(observed?.query).toMatchObject({
      queryText: 'What is the launch decision?',
      exactEntityRefs: ['thread:launch-decision'],
      limit: 5,
      queryHash: observed?.prepared.queryHash,
      embeddingProfileManifestHash:
        observed?.prepared.embeddingProfileManifestHash,
    });
    expect(observed?.prepared.vector).toBeInstanceOf(Float32Array);
    expect(observed?.prepared.vector).toHaveLength(producer.dimension);
  });

  it('binds issued rows to the active canonical manifest and rejects tampering', async () => {
    const producer = new DeterministicEffectDisabledEmbedding();
    const context = createDurableRequestContext();
    const authorizationEpoch = context.retrievalScope?.authorizationEpoch ?? 1;
    const text = 'Canonical ingestion recorded a launch-owner decision.';
    const sourceId = 'source-hosted-launch';
    const chunkId = 'chunk-hosted-launch';
    const sourceVersion = '7';
    const contentHash = sha256Text(text);
    const activeManifestHash = sha256Text(
      'canonical-aws-snapshot-for-hosted-launch',
    );
    const citation = citationSchema.parse({
      citationId: `${sourceId}:${chunkId}:${sourceVersion}`,
      sourceId,
      sourceVersion,
      chunkId,
      label: 'Canonical launch decision',
      contentHash,
      hydratedUnderAuthorizationEpoch: authorizationEpoch,
    });
    const result: AuthorizedRetrievalResult = Object.freeze({
      candidates: Object.freeze([
        retrievalCandidateSchema.parse({
          chunkId,
          sourceId,
          lexicalScore: 1,
          vectorScore: 1,
          fusedScore: 1,
          authorizationEpoch,
        }),
      ]),
      citations: Object.freeze([citation]),
      abstained: false,
      authorizationEpoch,
      snapshotManifestHash: activeManifestHash,
      scoringProfileVersion: 'chief-bounded-fusion-v1',
      evidence: Object.freeze([
        Object.freeze({
          chunkId,
          citationId: citation.citationId,
          text,
          exactEntityRefs: Object.freeze(['thread:launch-decision']),
          sourceClass: 'communication' as const,
          sourceAuthority: Object.freeze({
            contractVersion: 'chief-source-authority.v1' as const,
            verifiedBy: 'canonical_ingestion' as const,
            sourceClass: 'communication' as const,
            sourceKind: 'demo' as const,
            relationKind: 'canonical_thread' as const,
            relationTopic: 'release_readiness' as const,
          }),
          relation: Object.freeze({
            verified: true,
            kind: 'canonical_thread' as const,
            topic: 'release_readiness' as const,
            exactEntityRefs: Object.freeze(['thread:launch-decision']),
          }),
        }),
      ]),
    });
    let activeHash = activeManifestHash;
    const retrieval = createReadOnlyAwsRetrieval({
      queryVectors: {
        prepareInProcess: (queryText: string) =>
          prepareEffectDisabledQueryVector({ producer, queryText }),
      },
      index: {
        queryWithCitations: () => Promise.resolve(result),
        inspect: () =>
          Promise.resolve({
            status: 'ready' as const,
            authorizationEpoch,
            manifestHash: activeHash,
          }),
      },
    });
    const issued = await retrieval.search(context, {
      queryText: 'Who owns the launch decision?',
      exactEntityRefs: ['thread:launch-decision'],
      limit: 5,
    });
    const binding: DurableManifestBinding = {
      contractVersion: 'chief-validated-manifest-binding.v1',
      tenantId: context.retrievalScope?.tenantId as string,
      scopeHash: context.retrievalScope?.scopeHash as string,
      authorizationEpoch,
      role: 'factual',
      manifestHash: activeManifestHash,
      scoringProfileVersion: 'chief-bounded-fusion-v1',
      records: [
        {
          sourceId,
          chunkId,
          sourceVersion,
          authorizationEpoch,
          evidenceHash: contentHash,
        },
      ],
    };

    await expect(
      retrieval.verifyManifestBinding?.(context, binding, issued),
    ).resolves.toBe(true);
    await expect(
      retrieval.verifyManifestBinding?.(
        context,
        {
          ...binding,
          records: [{ ...binding.records[0]!, evidenceHash: 'f'.repeat(64) }],
        },
        issued,
      ),
    ).resolves.toBe(false);
    await expect(
      retrieval.verifyManifestBinding?.(context, binding, {
        ...issued,
        evidence: [{ ...issued.evidence[0]!, text: 'tampered evidence' }],
      }),
    ).resolves.toBe(false);
    activeHash = sha256Text('new-active-canonical-snapshot');
    await expect(
      retrieval.verifyManifestBinding?.(context, binding, issued),
    ).resolves.toBe(false);
  });
});
