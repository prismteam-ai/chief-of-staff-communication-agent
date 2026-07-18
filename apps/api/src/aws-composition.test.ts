import { describe, expect, it } from 'vitest';
import {
  DeterministicEffectDisabledEmbedding,
  prepareEffectDisabledQueryVector,
  type AuthorizedRetrievalResult,
  type InProcessQueryVector,
} from '@chief/rag';
import {
  deterministicEvaluatorIdentityV2,
  type RetrievalQuery,
} from '@chief/contracts';

import {
  createDurableRequestContext,
  createReadOnlyAwsRetrieval,
} from './aws-composition.js';

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
      },
    };
    const retrieval = createReadOnlyAwsRetrieval(runtime);

    await expect(
      retrieval.search(createDurableRequestContext(), {
        queryText: 'What is the launch decision?',
        exactEntityRefs: ['SEC-4821'],
        limit: 5,
      }),
    ).resolves.toBe(result);

    expect(persistedPrepareCalls).toBe(0);
    expect(observed?.query).toMatchObject({
      queryText: 'What is the launch decision?',
      exactEntityRefs: ['SEC-4821'],
      limit: 5,
      queryHash: observed?.prepared.queryHash,
      embeddingProfileManifestHash:
        observed?.prepared.embeddingProfileManifestHash,
    });
    expect(observed?.prepared.vector).toBeInstanceOf(Float32Array);
    expect(observed?.prepared.vector).toHaveLength(producer.dimension);
  });
});
