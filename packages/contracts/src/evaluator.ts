import {
  accountIdSchema,
  brandIdSchema,
  messageIdSchema,
  messageRevisionIdSchema,
  sha256Schema,
  tenantIdSchema,
  threadIdSchema,
  userIdSchema,
} from './ids.js';

const communications = Object.freeze([
  Object.freeze({
    messageId: messageIdSchema.parse('message-1'),
    messageRevisionId: messageRevisionIdSchema.parse('message-revision-1-1'),
    productThreadAlias: threadIdSchema.parse('thread-1'),
    retrievalExactEntityRef: threadIdSchema.parse(
      'thr_94f02c2953e5253d7f62f514efffdda78aa29090',
    ),
  }),
  Object.freeze({
    messageId: messageIdSchema.parse('message-2'),
    messageRevisionId: messageRevisionIdSchema.parse('message-revision-2-1'),
    productThreadAlias: threadIdSchema.parse('thread-2'),
    retrievalExactEntityRef: threadIdSchema.parse(
      'thr_309a81cf66fffd346b95eccaf016494a30abd88f',
    ),
  }),
] as const);

const evaluatorV2AccountIds = Object.freeze([
  accountIdSchema.parse('account-gmail-fixture'),
  accountIdSchema.parse('account-tenant-demo-northstar-microsoft_graph-01'),
  accountIdSchema.parse('account-tenant-demo-northstar-sms-02'),
  accountIdSchema.parse('account-tenant-demo-northstar-whatsapp-03'),
  accountIdSchema.parse('account-tenant-demo-northstar-x-04'),
  accountIdSchema.parse('account-tenant-demo-northstar-linkedin_archive-05'),
  accountIdSchema.parse('account-tenant-demo-northstar-future_demo-06'),
] as const);

const evaluatorV2BrandIds = Object.freeze([
  brandIdSchema.parse('brand-northstar'),
  brandIdSchema.parse('brand-harbor'),
] as const);

/**
 * Public deterministic evaluator aliases and retrieval identities.
 *
 * Provider-native identifiers intentionally remain outside this contract.
 */
export const deterministicEvaluatorIdentityV1 = Object.freeze({
  contractVersion: 'chief-deterministic-evaluator-identity.v1' as const,
  tenantId: tenantIdSchema.parse('tenant_public_assessment'),
  userId: userIdSchema.parse('user_public_evaluator'),
  accountId: accountIdSchema.parse('account-gmail-fixture'),
  brandId: brandIdSchema.parse('brand-executive'),
  authorizationEpoch: 1 as const,
  scopeHash: sha256Schema.parse(
    'b591109c0ddfc4a602f56768cbbd7df2eb9606f7d45dc986cf5ca6f914dca4f1',
  ),
  connector: Object.freeze({
    connectorId: 'gmail' as const,
    descriptorVersion: '1.0.0' as const,
    runtimeMode: 'fixture' as const,
    capabilitySnapshotHash: sha256Schema.parse(
      '9ed74a7ccec9f7718e63842fb79ecf8d8a298e132b4db598096ce7b7c3dc5c65',
    ),
  }),
  communications,
});

/**
 * Additive public evaluator identity for the generated hosted corpus.
 *
 * V1 remains immutable so existing durable proposal and retrieval evidence can
 * still be interpreted. V2 keeps the two public message aliases and canonical
 * retrieval thread references while widening only the server-owned account and
 * brand scope. The corpus hash identifies the already validated synthetic
 * generator output; the isolation tenant is intentionally absent.
 */
export const deterministicEvaluatorIdentityV2 = Object.freeze({
  contractVersion: 'chief-deterministic-evaluator-identity.v2' as const,
  tenantId: deterministicEvaluatorIdentityV1.tenantId,
  userId: deterministicEvaluatorIdentityV1.userId,
  accountId: evaluatorV2AccountIds[0],
  brandId: evaluatorV2BrandIds[0],
  accountIds: evaluatorV2AccountIds,
  brandIds: evaluatorV2BrandIds,
  authorizationEpoch: 1 as const,
  scopeHash: sha256Schema.parse(
    '78f117a88b1fc73ce8c394e2045888eb102fd34ee3e8c77fbaa75cb21d9a8e3d',
  ),
  corpus: Object.freeze({
    seed: 20_260_717 as const,
    generatedAt: '2026-07-17T09:00:00.000Z' as const,
    resetVersion: 'demo-reset-v1' as const,
    corpusHash: sha256Schema.parse(
      '33399aa2c189c8c9cdc7536585f9a167163704d9315cfeeaa30d8124e64f2bf7',
    ),
    primaryTenantId: 'tenant-demo-northstar' as const,
    messageCount: 1_120 as const,
    threadCount: 160 as const,
    channelCount: 7 as const,
    accountCount: 7 as const,
    brandCount: 2 as const,
  }),
  anchorOverlays: Object.freeze([
    Object.freeze({
      ...communications[0],
      corpusThreadId: threadIdSchema.parse('thread-tenant-demo-northstar-0000'),
      corpusMessageId: messageIdSchema.parse(
        'message-tenant-demo-northstar-0000-00',
      ),
      corpusMessageRevisionId: messageRevisionIdSchema.parse(
        'revision-tenant-demo-northstar-0000-00',
      ),
      providerMessageId: 'evaluator-message-1' as const,
      providerThreadId: 'evaluator-thread-1' as const,
    }),
    Object.freeze({
      ...communications[1],
      corpusThreadId: threadIdSchema.parse('thread-tenant-demo-northstar-0007'),
      corpusMessageId: messageIdSchema.parse(
        'message-tenant-demo-northstar-0007-00',
      ),
      corpusMessageRevisionId: messageRevisionIdSchema.parse(
        'revision-tenant-demo-northstar-0007-00',
      ),
      providerMessageId: 'evaluator-message-2' as const,
      providerThreadId: 'evaluator-thread-2' as const,
    }),
  ] as const),
});
