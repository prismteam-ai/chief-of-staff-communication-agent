import { describe, expect, it } from 'vitest';

import {
  deterministicEvaluatorIdentityV1,
  deterministicEvaluatorIdentityV2,
} from './evaluator.js';

describe('deterministic evaluator identity contract', () => {
  it('maps public aliases to canonical retrieval entities without provider IDs', () => {
    expect(deterministicEvaluatorIdentityV1).toEqual({
      contractVersion: 'chief-deterministic-evaluator-identity.v1',
      tenantId: 'tenant_public_assessment',
      userId: 'user_public_evaluator',
      accountId: 'account-gmail-fixture',
      brandId: 'brand-executive',
      authorizationEpoch: 1,
      scopeHash:
        'b591109c0ddfc4a602f56768cbbd7df2eb9606f7d45dc986cf5ca6f914dca4f1',
      connector: {
        connectorId: 'gmail',
        descriptorVersion: '1.0.0',
        runtimeMode: 'fixture',
        capabilitySnapshotHash:
          '9ed74a7ccec9f7718e63842fb79ecf8d8a298e132b4db598096ce7b7c3dc5c65',
      },
      communications: [
        {
          messageId: 'message-1',
          messageRevisionId: 'message-revision-1-1',
          productThreadAlias: 'thread-1',
          retrievalExactEntityRef:
            'thr_94f02c2953e5253d7f62f514efffdda78aa29090',
        },
        {
          messageId: 'message-2',
          messageRevisionId: 'message-revision-2-1',
          productThreadAlias: 'thread-2',
          retrievalExactEntityRef:
            'thr_309a81cf66fffd346b95eccaf016494a30abd88f',
        },
      ],
    });
    expect(JSON.stringify(deterministicEvaluatorIdentityV1)).not.toContain(
      'evaluator-thread',
    );
  });

  it('adds an immutable V2 portfolio scope without changing V1 aliases', () => {
    expect(deterministicEvaluatorIdentityV2).toMatchObject({
      contractVersion: 'chief-deterministic-evaluator-identity.v2',
      tenantId: deterministicEvaluatorIdentityV1.tenantId,
      userId: deterministicEvaluatorIdentityV1.userId,
      accountId: 'account-gmail-fixture',
      brandId: 'brand-northstar',
      authorizationEpoch: 1,
      scopeHash:
        '78f117a88b1fc73ce8c394e2045888eb102fd34ee3e8c77fbaa75cb21d9a8e3d',
      corpus: {
        seed: 20_260_717,
        generatedAt: '2026-07-17T09:00:00.000Z',
        resetVersion: 'demo-reset-v1',
        corpusHash:
          '33399aa2c189c8c9cdc7536585f9a167163704d9315cfeeaa30d8124e64f2bf7',
        primaryTenantId: 'tenant-demo-northstar',
        messageCount: 1_120,
        threadCount: 160,
        channelCount: 7,
        accountCount: 7,
        brandCount: 2,
      },
    });
    expect(deterministicEvaluatorIdentityV2.accountIds).toHaveLength(7);
    expect(new Set(deterministicEvaluatorIdentityV2.accountIds).size).toBe(7);
    expect(deterministicEvaluatorIdentityV2.brandIds).toEqual([
      'brand-northstar',
      'brand-harbor',
    ]);
    expect(deterministicEvaluatorIdentityV2.anchorOverlays).toHaveLength(2);
    expect(
      deterministicEvaluatorIdentityV2.anchorOverlays.map(
        ({ messageRevisionId, retrievalExactEntityRef }) => ({
          messageRevisionId,
          retrievalExactEntityRef,
        }),
      ),
    ).toEqual(
      deterministicEvaluatorIdentityV1.communications.map(
        ({ messageRevisionId, retrievalExactEntityRef }) => ({
          messageRevisionId,
          retrievalExactEntityRef,
        }),
      ),
    );
    expect(
      JSON.stringify(deterministicEvaluatorIdentityV2.accountIds),
    ).not.toContain('tenant-demo-isolation');
  });
});
