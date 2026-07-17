import { describe, expect, it } from 'vitest';

import {
  getCommunicationResultSchema,
  getConnectorStatusResultSchema,
  getThreadContextResultSchema,
  listCommunicationsResultSchema,
} from './api.js';

const now = '2026-07-17T12:00:00.000Z';
const secretSentinel = 'SECRET_INTERNAL_REF_DO_NOT_SERIALIZE';

const communicationSummary = {
  messageId: 'message-a',
  messageRevisionId: 'message-revision-a',
  revision: 1,
  threadId: 'thread-a',
  direction: 'inbound',
  status: 'pending',
  senderDisplayName: 'Customer',
  recipientDisplayNames: ['Chief of Staff'],
  subject: 'Quarterly review',
  excerpt: 'Can we move the review to Friday?',
  attachmentCount: 0,
  sourceTimestamp: now,
  productUrl: 'https://chief.example/communications/message-a',
};

describe('client-safe read projections', () => {
  it('serializes communication views without persistence references', () => {
    const list = listCommunicationsResultSchema.parse({
      items: [communicationSummary],
    });
    const detail = getCommunicationResultSchema.parse({
      communication: {
        ...communicationSummary,
        authoredText: 'Can we move the review to Friday?',
        normalizedText: 'Can we move the review to Friday?',
        attachments: [],
        citations: [],
      },
    });
    const thread = getThreadContextResultSchema.parse({
      thread: {
        threadId: 'thread-a',
        channel: 'email',
        subject: 'Quarterly review',
        participantDisplayNames: ['Customer', 'Chief of Staff'],
        status: 'active',
        latestMessageRevisionId: 'message-revision-a',
        sourceUpdatedAt: now,
        communications: [communicationSummary],
        productUrl: 'https://chief.example/threads/thread-a',
      },
    });
    expect(JSON.stringify({ list, detail, thread })).not.toContain(
      secretSentinel,
    );
    expect(
      getCommunicationResultSchema.safeParse({
        communication: {
          ...detail.communication,
          immutableProviderBody: secretSentinel,
        },
      }).success,
    ).toBe(false);
    expect(
      getThreadContextResultSchema.safeParse({
        thread: {
          ...thread.thread,
          providerThreadIdDigest: secretSentinel,
        },
      }).success,
    ).toBe(false);

    for (const internalField of [
      'encryptedAddressRef',
      'immutableProviderBody',
      'providerMessageIdDigest',
      'providerThreadIdDigest',
      'connectorSnapshot',
      'bucketRef',
      'objectKey',
      'encryptionKeyRef',
    ]) {
      expect(
        listCommunicationsResultSchema.safeParse({
          items: [{ ...communicationSummary, [internalField]: secretSentinel }],
        }).success,
      ).toBe(false);
    }
  });

  it('serializes connector status without owner, identity, or credential data', () => {
    const capabilities = {
      read: true,
      send: false,
      webhook: false,
      poll: true,
      threads: true,
      attachments: true,
      deliveryFeedback: false,
      multipleAccounts: true,
      historicalBackfill: true,
      externalEffect: false,
      replyCorrelation: true,
      complaintFeedback: false,
      unsubscribeFeedback: false,
      optOutFeedback: false,
      reconsentFeedback: false,
      consentWindowEligibility: false,
    };
    const connector = {
      accountId: 'account-a',
      brandId: 'brand-a',
      connectorId: 'gmail',
      displayLabel: 'Work Gmail',
      provider: 'google',
      connectorKind: 'communication',
      channel: 'email',
      status: 'active',
      health: 'healthy',
      runtimeMode: 'fixture',
      selectionState: 'selected',
      capabilities,
      lastSyncAt: now,
      productUrl: 'https://chief.example/settings/connectors/account-a',
    };
    const parsed = getConnectorStatusResultSchema.parse({
      connectors: [connector],
    });
    expect(JSON.stringify(parsed)).not.toContain(secretSentinel);

    for (const internalField of [
      'tenantId',
      'ownerUserId',
      'providerAccountDigest',
      'encryptedRefreshTokenRef',
      'connectorSnapshot',
      'verifiedActorContext',
    ]) {
      expect(
        getConnectorStatusResultSchema.safeParse({
          connectors: [{ ...connector, [internalField]: secretSentinel }],
        }).success,
      ).toBe(false);
    }
  });
});
