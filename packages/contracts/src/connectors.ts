import { z } from 'zod';

import {
  accountIdSchema,
  brandIdSchema,
  keyedDigestValueSchema,
  nonNegativeIntegerSchema,
  positiveEpochSchema,
  sha256Schema,
  tenantIdSchema,
  timestampSchema,
  userIdSchema,
  versionSchema,
} from './ids.js';

export const connectionStrategySchema = z.enum([
  'oauth',
  'credential',
  'external',
  'none',
]);
export const authorizationStrategyDescriptorSchema = z.discriminatedUnion(
  'strategy',
  [
    z
      .object({
        strategy: z.literal('oauth'),
        audience: z.string().min(1),
        scopes: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    z
      .object({
        strategy: z.literal('credential'),
        credentialReferenceClass: z.string().min(1),
      })
      .strict(),
    z.object({ strategy: z.literal('external') }).strict(),
    z.object({ strategy: z.literal('none') }).strict(),
  ],
);
export const connectorRuntimeModeSchema = z.enum([
  'live',
  'live_trial',
  'sandbox',
  'virtual_test',
  'fixture',
  'manual',
  'blocked_external_access',
  'disabled',
]);
export const connectorSelectionStateSchema = z.enum([
  'selected',
  'unselected_candidate',
  'fallback_candidate',
  'not_applicable',
]);

export const connectorCapabilitiesSchema = z
  .object({
    read: z.boolean(),
    send: z.boolean(),
    webhook: z.boolean(),
    poll: z.boolean(),
    threads: z.boolean(),
    attachments: z.boolean(),
    deliveryFeedback: z.boolean(),
    multipleAccounts: z.boolean(),
    historicalBackfill: z.boolean(),
    externalEffect: z.boolean(),
    replyCorrelation: z.boolean(),
    complaintFeedback: z.boolean(),
    unsubscribeFeedback: z.boolean(),
    optOutFeedback: z.boolean(),
    reconsentFeedback: z.boolean(),
    consentWindowEligibility: z.boolean(),
  })
  .strict();

export const workManagementCapabilitiesSchema = z
  .object({
    readTasks: z.boolean(),
    readProjects: z.boolean(),
    readMilestones: z.boolean(),
    readComments: z.boolean(),
    createTask: z.boolean(),
    updateTask: z.boolean(),
    createComment: z.boolean(),
    webhooks: z.boolean(),
    attachments: z.boolean(),
    multipleAccounts: z.boolean(),
    externalEffect: z.boolean(),
  })
  .strict();

export const connectorDescriptorSchema = z
  .object({
    schemaVersion: z.literal('1'),
    connectorId: z.string().min(1),
    descriptorVersion: versionSchema,
    provider: z.string().min(1),
    channel: z.string().min(1),
    connectionStrategy: connectionStrategySchema,
    credentialReferenceClass: z.string().min(1).optional(),
    authorizationAudience: z.string().min(1).optional(),
    authorizationScopes: z.array(z.string().min(1)),
    capabilities: connectorCapabilitiesSchema,
    supportedRuntimeModes: z.array(connectorRuntimeModeSchema).min(1),
    constraints: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((descriptor, context) => {
    const oauthValid =
      descriptor.connectionStrategy === 'oauth' &&
      descriptor.authorizationAudience !== undefined &&
      descriptor.authorizationScopes.length > 0 &&
      descriptor.credentialReferenceClass === undefined;
    const credentialValid =
      descriptor.connectionStrategy === 'credential' &&
      descriptor.credentialReferenceClass !== undefined &&
      descriptor.authorizationAudience === undefined &&
      descriptor.authorizationScopes.length === 0;
    const passiveValid =
      (descriptor.connectionStrategy === 'external' ||
        descriptor.connectionStrategy === 'none') &&
      descriptor.credentialReferenceClass === undefined &&
      descriptor.authorizationAudience === undefined &&
      descriptor.authorizationScopes.length === 0;
    if (!oauthValid && !credentialValid && !passiveValid) {
      context.addIssue({
        code: 'custom',
        message:
          'connector authorization fields must match exactly one connection strategy',
        path: ['connectionStrategy'],
      });
    }
  });

export const workManagementDescriptorSchema = z
  .object({
    schemaVersion: z.literal('1'),
    connectorId: z.string().min(1),
    descriptorVersion: versionSchema,
    provider: z.string().min(1),
    connectionStrategy: connectionStrategySchema,
    credentialReferenceClass: z.string().min(1).optional(),
    authorizationAudience: z.string().min(1).optional(),
    authorizationScopes: z.array(z.string().min(1)),
    capabilities: workManagementCapabilitiesSchema,
    supportedRuntimeModes: z.array(connectorRuntimeModeSchema).min(1),
    constraints: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((descriptor, context) => {
    const oauthValid =
      descriptor.connectionStrategy === 'oauth' &&
      descriptor.authorizationAudience !== undefined &&
      descriptor.authorizationScopes.length > 0 &&
      descriptor.credentialReferenceClass === undefined;
    const credentialValid =
      descriptor.connectionStrategy === 'credential' &&
      descriptor.credentialReferenceClass !== undefined &&
      descriptor.authorizationAudience === undefined &&
      descriptor.authorizationScopes.length === 0;
    const passiveValid =
      (descriptor.connectionStrategy === 'external' ||
        descriptor.connectionStrategy === 'none') &&
      descriptor.credentialReferenceClass === undefined &&
      descriptor.authorizationAudience === undefined &&
      descriptor.authorizationScopes.length === 0;
    if (!oauthValid && !credentialValid && !passiveValid) {
      context.addIssue({
        code: 'custom',
        message:
          'work-management authorization fields must match exactly one connection strategy',
        path: ['connectionStrategy'],
      });
    }
  });

export const workObjectKindSchema = z.enum([
  'task',
  'project',
  'milestone',
  'comment',
]);

export const workObjectRefSchema = z
  .object({
    kind: workObjectKindSchema,
    providerObjectId: z.string().min(1),
  })
  .strict();

export const workObjectFactSchema = z
  .object({
    kind: workObjectKindSchema,
    providerObjectId: z.string().min(1),
    providerVersion: versionSchema,
    providerTimestamp: timestampSchema,
    payloadFingerprint: sha256Schema,
  })
  .strict();

export const connectorSnapshotSchema = z
  .object({
    connectorId: z.string().min(1),
    descriptorVersion: versionSchema,
    accountId: accountIdSchema,
    capabilitySnapshotHash: sha256Schema,
    runtimeMode: connectorRuntimeModeSchema,
    selectionState: connectorSelectionStateSchema,
  })
  .strict();

export const connectorAccountSchema = z
  .object({
    tenantId: tenantIdSchema,
    accountId: accountIdSchema,
    ownerUserId: userIdSchema,
    brandId: brandIdSchema.optional(),
    provider: z.string().min(1),
    channel: z.string().min(1),
    providerAccountDigest: keyedDigestValueSchema,
    displayLabel: z.string().min(1).max(200),
    snapshot: connectorSnapshotSchema,
    status: z.enum(['pending', 'active', 'degraded', 'revoked', 'disabled']),
    health: z.enum(['unknown', 'healthy', 'degraded', 'failed']),
    stateVersion: z.number().int().positive(),
    lastSyncAt: timestampSchema.optional(),
    authExpiresAt: timestampSchema.optional(),
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((account, context) => {
    if (account.accountId !== account.snapshot.accountId) {
      context.addIssue({
        code: 'custom',
        message: 'connector snapshot must belong to the account',
        path: ['snapshot', 'accountId'],
      });
    }
  });

export const connectorAccountRefSchema = z
  .object({
    tenantId: tenantIdSchema,
    accountId: accountIdSchema,
    expectedStateVersion: z.number().int().positive(),
  })
  .strict();

export const authorizationInputSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    userId: userIdSchema,
    connectorId: z.string().min(1),
    redirectUri: z.url(),
    stateDigest: sha256Schema,
    pkceChallenge: z.string().min(43).max(128),
    requestedScopes: z.array(z.string().min(1)),
  })
  .strict();

export const authorizationStartSchema = z
  .object({
    authorizationUrl: z.url(),
    stateDigest: sha256Schema,
    expiresAt: timestampSchema,
  })
  .strict();

export const authorizationCallbackSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    userId: userIdSchema,
    stateDigest: sha256Schema,
    code: z.string().min(1),
    pkceVerifier: z.string().min(43).max(128),
    callbackUri: z.url(),
  })
  .strict();

export const credentialConnectionInputSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    userId: userIdSchema,
    connectorId: z.string().min(1),
    secretReference: z.string().min(1),
    credentialClass: z.string().min(1),
  })
  .strict();

export const connectionHealthSchema = z
  .object({
    account: connectorAccountRefSchema,
    health: z.enum(['healthy', 'degraded', 'failed']),
    observedAt: timestampSchema,
    capabilitySnapshotHash: sha256Schema,
    errorCode: z.string().min(1).optional(),
  })
  .strict();

export const oauthCredentialStateSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    accountId: accountIdSchema,
    providerSubjectDigest: keyedDigestValueSchema,
    encryptedRefreshTokenRef: z.string().min(1),
    envelopeVersion: versionSchema,
    credentialEpoch: positiveEpochSchema,
    optimisticVersion: positiveEpochSchema,
    audience: z.string().min(1),
    scopes: z.array(z.string().min(1)),
    tokenVersionDigest: sha256Schema,
    status: z.enum([
      'active',
      'rotating',
      'revoked',
      'reauthorization_required',
    ]),
    expiresAt: timestampSchema.optional(),
    updatedAt: timestampSchema,
  })
  .strict();

export const refreshClaimSchema = z
  .object({
    tenantId: tenantIdSchema,
    accountId: accountIdSchema,
    credentialEpoch: positiveEpochSchema,
    claimEpoch: positiveEpochSchema,
    requestFingerprint: sha256Schema,
    owner: z.string().min(1),
    expiresAt: timestampSchema,
    recoveryProfileVersion: versionSchema,
  })
  .strict();

export const subscriptionLeaseStatusSchema = z.enum([
  'candidate',
  'active',
  'renewing',
  'expired',
  'invalidated',
  'teardown_pending',
]);

export const subscriptionLeaseSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    accountId: accountIdSchema,
    resourceScopeHash: sha256Schema,
    kind: z.enum(['subscription', 'watch', 'cursor']),
    encryptedProviderReference: z.string().min(1).optional(),
    clientStateSecretRef: z.string().min(1).optional(),
    leaseEpoch: positiveEpochSchema,
    optimisticVersion: positiveEpochSchema,
    expiresAt: timestampSchema,
    renewAfter: timestampSchema,
    status: subscriptionLeaseStatusSchema,
    lastReconciledAt: timestampSchema.optional(),
    invalidationReason: z.string().min(1).optional(),
  })
  .strict();

export const leaseMutationClaimSchema = z
  .object({
    tenantId: tenantIdSchema,
    accountId: accountIdSchema,
    resourceScopeHash: sha256Schema,
    leaseEpoch: positiveEpochSchema,
    mutationEpoch: positiveEpochSchema,
    requestFingerprint: sha256Schema,
    owner: z.string().min(1),
    expiresAt: timestampSchema,
    mutation: z.enum(['create', 'renew', 'replace', 'teardown']),
  })
  .strict();

export const subscriptionMutationRequestSchema = z
  .object({
    schemaVersion: z.literal('1'),
    account: connectorAccountRefSchema,
    resourceScopeHash: sha256Schema,
    expectedLeaseEpoch: positiveEpochSchema,
    mutationClaim: leaseMutationClaimSchema,
    expectedClaimRequestFingerprint: sha256Schema,
    expectedMutation: z.enum(['create', 'renew', 'replace', 'teardown']),
    providerIdempotencyKey: z.string().min(1),
    requestedExpiresAt: timestampSchema,
    hostedCallbackReleaseHash: sha256Schema.optional(),
    hostedCallbackDeploymentHash: sha256Schema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.account.tenantId !== request.mutationClaim.tenantId ||
      request.account.accountId !== request.mutationClaim.accountId ||
      request.resourceScopeHash !== request.mutationClaim.resourceScopeHash ||
      request.expectedLeaseEpoch !== request.mutationClaim.leaseEpoch
    ) {
      context.addIssue({
        code: 'custom',
        message: 'subscription request scope and epoch must bind the claim',
        path: ['mutationClaim'],
      });
    }
    if (
      request.expectedClaimRequestFingerprint !==
      request.mutationClaim.requestFingerprint
    ) {
      context.addIssue({
        code: 'custom',
        message: 'expected request fingerprint must bind the mutation claim',
        path: ['expectedClaimRequestFingerprint'],
      });
    }
    if (request.expectedMutation !== request.mutationClaim.mutation) {
      context.addIssue({
        code: 'custom',
        message: 'expected mutation must bind the mutation claim',
        path: ['expectedMutation'],
      });
    }
  });

export const providerSubscriptionResultSchema = z
  .object({
    providerReference: z.string().min(1),
    providerResponseHash: sha256Schema,
    expiresAt: timestampSchema,
    renewAfter: timestampSchema,
    observedAt: timestampSchema,
  })
  .strict();

export const syncCheckpointSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    accountId: accountIdSchema,
    resourceScopeHash: sha256Schema,
    kind: z.enum(['history', 'delta', 'uid', 'cursor', 'page']),
    encryptedCursor: z.string().min(1),
    checkpointEpoch: positiveEpochSchema,
    adapterVersion: versionSchema,
    sourceWatermark: z.string().min(1),
    lastCompletePage: nonNegativeIntegerSchema,
    leaseEpoch: positiveEpochSchema.optional(),
    status: z.enum(['active', 'reset_required', 'invalidated']),
    committedAt: timestampSchema,
  })
  .strict();

export const pollRequestSchema = z
  .object({
    schemaVersion: z.literal('1'),
    account: connectorAccountRefSchema,
    resourceScopeHash: sha256Schema,
    checkpoint: syncCheckpointSchema,
    expectedCheckpointEpoch: positiveEpochSchema,
    adapterVersion: versionSchema,
    maxItems: z.number().int().positive().max(1_000),
    maxPages: z.number().int().positive().max(10),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.account.tenantId !== request.checkpoint.tenantId ||
      request.account.accountId !== request.checkpoint.accountId ||
      request.resourceScopeHash !== request.checkpoint.resourceScopeHash ||
      request.expectedCheckpointEpoch !== request.checkpoint.checkpointEpoch ||
      request.adapterVersion !== request.checkpoint.adapterVersion
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'poll request must bind its account, scope, epoch, and adapter',
        path: ['checkpoint'],
      });
    }
  });

export const providerMessageRefSchema = z
  .object({
    providerMessageId: z.string().min(1),
    providerThreadId: z.string().min(1).optional(),
  })
  .strict();

export const providerThreadRefSchema = z
  .object({ providerThreadId: z.string().min(1) })
  .strict();

export const canonicalEnvelopeSchema = z
  .object({
    schemaVersion: z.literal('1'),
    account: connectorAccountRefSchema,
    providerMessageRef: providerMessageRefSchema,
    sourceTimestamp: timestampSchema,
    rawBodyRef: z.string().min(1),
    canonicalPayloadHash: sha256Schema,
    attachmentCount: z.number().int().nonnegative(),
    connectorSnapshot: connectorSnapshotSchema,
  })
  .strict();

export const syncPageSchema = z
  .object({
    envelopes: z.array(canonicalEnvelopeSchema),
    nextEncryptedCursor: z.string().min(1).optional(),
    sourceWatermark: z.string().min(1),
    complete: z.boolean(),
    providerResponseHash: sha256Schema,
  })
  .strict();

export const rawWebhookRequestSchema = z
  .object({
    method: z.string().min(1),
    providerVisibleUrl: z.url(),
    headers: z.record(z.string(), z.string()),
    rawBodyBase64: z.string().min(1),
    receivedAt: timestampSchema,
  })
  .strict();

export const webhookVerificationSchema = z.discriminatedUnion('verified', [
  z
    .object({
      verified: z.literal(true),
      verificationMethod: z.string().min(1),
      providerEventId: z.string().min(1),
      rawPayloadDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      verified: z.literal(false),
      reasonCode: z.string().min(1),
    })
    .strict(),
]);

export const verifiedProviderEventSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    accountId: accountIdSchema,
    providerEventId: z.string().min(1),
    rawEventRef: z.string().min(1),
    rawPayloadDigest: sha256Schema,
    verifiedAt: timestampSchema,
    verificationMethod: z.string().min(1),
    connectorSnapshot: connectorSnapshotSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.accountId !== event.connectorSnapshot.accountId) {
      context.addIssue({
        code: 'custom',
        message: 'verified event snapshot must belong to the account',
        path: ['connectorSnapshot', 'accountId'],
      });
    }
  });

export const normalizedInboundEventSchema = z
  .object({
    schemaVersion: z.literal('1'),
    verifiedEvent: verifiedProviderEventSchema,
    providerMessageId: z.string().min(1),
    providerThreadId: z.string().min(1).optional(),
    sourceTimestamp: timestampSchema,
    canonicalPayloadHash: sha256Schema,
  })
  .strict();

export type ConnectorDescriptor = z.infer<typeof connectorDescriptorSchema>;
export type ConnectionStrategy = z.infer<typeof connectionStrategySchema>;
export type AuthorizationStrategyDescriptor = z.infer<
  typeof authorizationStrategyDescriptorSchema
>;
export type ConnectorCapabilities = z.infer<typeof connectorCapabilitiesSchema>;
export type WorkManagementCapabilities = z.infer<
  typeof workManagementCapabilitiesSchema
>;
export type WorkManagementDescriptor = z.infer<
  typeof workManagementDescriptorSchema
>;
export type WorkObjectKind = z.infer<typeof workObjectKindSchema>;
export type WorkObjectRef = z.infer<typeof workObjectRefSchema>;
export type WorkObjectFact = z.infer<typeof workObjectFactSchema>;
export type ConnectorRuntimeMode = z.infer<typeof connectorRuntimeModeSchema>;
export type ConnectorSelectionState = z.infer<
  typeof connectorSelectionStateSchema
>;
export type ConnectorSnapshot = z.infer<typeof connectorSnapshotSchema>;
export type ConnectorAccount = z.infer<typeof connectorAccountSchema>;
export type ConnectorAccountRef = z.infer<typeof connectorAccountRefSchema>;
export type AuthorizationInput = z.infer<typeof authorizationInputSchema>;
export type AuthorizationStart = z.infer<typeof authorizationStartSchema>;
export type AuthorizationCallback = z.infer<typeof authorizationCallbackSchema>;
export type CredentialConnectionInput = z.infer<
  typeof credentialConnectionInputSchema
>;
export type ConnectionHealth = z.infer<typeof connectionHealthSchema>;
export type OAuthCredentialState = z.infer<typeof oauthCredentialStateSchema>;
export type RefreshClaim = z.infer<typeof refreshClaimSchema>;
export type SubscriptionLease = z.infer<typeof subscriptionLeaseSchema>;
export type LeaseMutationClaim = z.infer<typeof leaseMutationClaimSchema>;
export type SubscriptionMutationRequest = z.infer<
  typeof subscriptionMutationRequestSchema
>;
export type ProviderSubscriptionResult = z.infer<
  typeof providerSubscriptionResultSchema
>;
export type SyncCheckpoint = z.infer<typeof syncCheckpointSchema>;
export type PollRequest = z.infer<typeof pollRequestSchema>;
export type ProviderMessageRef = z.infer<typeof providerMessageRefSchema>;
export type ProviderThreadRef = z.infer<typeof providerThreadRefSchema>;
export type CanonicalEnvelope = z.infer<typeof canonicalEnvelopeSchema>;
export type SyncPage = z.infer<typeof syncPageSchema>;
export type RawWebhookRequest = z.infer<typeof rawWebhookRequestSchema>;
export type WebhookVerification = z.infer<typeof webhookVerificationSchema>;
export type VerifiedProviderEvent = z.infer<typeof verifiedProviderEventSchema>;
export type NormalizedInboundEvent = z.infer<
  typeof normalizedInboundEventSchema
>;
