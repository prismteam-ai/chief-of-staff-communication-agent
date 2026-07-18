import { describe, expect, it } from 'vitest';

import { deterministicEvaluatorIdentityV1 } from './evaluator.js';

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
});
