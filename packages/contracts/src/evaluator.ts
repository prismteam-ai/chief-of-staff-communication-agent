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
