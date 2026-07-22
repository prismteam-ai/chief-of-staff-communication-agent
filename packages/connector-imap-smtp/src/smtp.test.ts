import { effectExecutionArtifactSchema } from '@chief/contracts/approval';
import { createConnectorContractFixtures } from '@chief/connector-testkit';
import { describe, expect, it, vi } from 'vitest';

import { smtpRenderedFixture } from './provider-fixtures.js';
import {
  bindSmtpCorrelation,
  dispatchSmtpData,
  reconcileSmtpSent,
  sha256,
  type SmtpWirePort,
} from './smtp.js';

function fixtureArtifact() {
  const base = createConnectorContractFixtures().artifact;
  const messageId = '<operation-a@example.invalid>';
  const raw = smtpRenderedFixture(messageId);
  return {
    raw,
    artifact: effectExecutionArtifactSchema.parse({
      ...base,
      renderedPayloadFingerprint: sha256(raw),
      clientCorrelation: { kind: 'rfc_message_id', value: messageId },
      reconciliationStrategy: 'smtp-sent-folder',
      reconciliationStrategyVersion: '1',
    }),
  };
}

function port(
  reply: Awaited<ReturnType<SmtpWirePort['submitData']>> = {
    kind: 'accepted',
    code: 250,
    exactResponse: '250 2.0.0 queued as queue-17',
    serverQueueId: 'queue-17',
    observedAt: '2026-07-17T12:00:01.000Z',
  },
): { readonly wire: SmtpWirePort; readonly calls: string[] } {
  const { raw } = fixtureArtifact();
  const calls: string[] = [];
  const wire: SmtpWirePort = {
    loadRenderedMessage: vi.fn(() =>
      Promise.resolve({
        envelopeFrom: 'chief@example.test',
        envelopeTo: ['recipient@example.test'],
        raw,
      }),
    ),
    persistPreDataBinding: vi.fn(() => {
      calls.push('persist_binding');
      return Promise.resolve();
    }),
    submitData: vi.fn(() => {
      calls.push('smtp_data');
      return Promise.resolve(reply);
    }),
    searchSent: vi.fn((input: Parameters<SmtpWirePort['searchSent']>[0]) =>
      Promise.resolve({
        matches: [
          {
            folder: 'Sent',
            uidValidity: '900',
            uid: 42,
            messageId: input.binding.messageId,
            envelopeFingerprint: input.binding.envelopeFingerprint,
            renderedPayloadHash: input.binding.renderedPayloadHash,
            observedAt: '2026-07-17T12:02:00.000Z',
          },
        ],
        conclusiveAbsence: false,
        providerResponseHash: 'a'.repeat(64),
        observedAt: '2026-07-17T12:02:00.000Z',
      }),
    ),
  };
  return { wire, calls };
}

describe('SMTP correlation, dispatch, and Sent reconciliation', () => {
  it('binds Message-ID, envelope, operation, payload, and version before DATA', async () => {
    const { artifact, raw } = fixtureArtifact();
    const current = port();
    const result = await dispatchSmtpData({
      port: current.wire,
      account: artifact.account,
      artifact,
    });
    expect(current.calls).toEqual(['persist_binding', 'smtp_data']);
    expect(result).toMatchObject({
      outcome: 'accepted',
      providerCorrelation: 'queue-17',
    });
    const binding = bindSmtpCorrelation(artifact, {
      envelopeFrom: 'chief@example.test',
      envelopeTo: ['recipient@example.test'],
      raw,
    });
    expect(binding).toMatchObject({
      operationId: artifact.operationId,
      attemptId: artifact.attemptId,
      messageId: artifact.clientCorrelation.value,
      renderedPayloadHash: artifact.renderedPayloadFingerprint,
      correlationBindingVersion: artifact.correlationBindingVersion,
    });
  });

  it('keeps a 2xx without real provider correlation acceptance_unknown', async () => {
    const { artifact } = fixtureArtifact();
    const current = port({
      kind: 'accepted',
      code: 250,
      exactResponse: '250 accepted without a queue identifier',
      observedAt: '2026-07-17T12:00:01.000Z',
    });
    const result = await dispatchSmtpData({
      port: current.wire,
      account: artifact.account,
      artifact,
    });
    expect(result).toMatchObject({
      outcome: 'acceptance_unknown',
      providerResponseHash: sha256('250 accepted without a queue identifier'),
      reasonCode: 'smtp_accepted_without_provider_correlation',
    });
    expect(result).not.toHaveProperty('providerCorrelation');
  });

  it('freezes inconclusive final replies as acceptance_unknown', async () => {
    const { artifact } = fixtureArtifact();
    const current = port({
      kind: 'inconclusive',
      reason: 'timeout_after_data',
      observedAt: '2026-07-17T12:00:02.000Z',
    });
    await expect(
      dispatchSmtpData({
        port: current.wire,
        account: artifact.account,
        artifact,
      }),
    ).resolves.toMatchObject({
      outcome: 'acceptance_unknown',
      reasonCode: 'timeout_after_data',
    });
  });

  it('accepts exactly one strong Sent match and preserves ambiguity otherwise', async () => {
    const { artifact } = fixtureArtifact();
    const current = port();
    await expect(
      reconcileSmtpSent({
        port: current.wire,
        account: artifact.account,
        artifact,
        maxProviderQueries: 2,
      }),
    ).resolves.toMatchObject({
      outcome: 'accepted',
      providerCorrelation: 'imap-sent:Sent:900:42',
    });
    const ambiguous: SmtpWirePort = {
      ...current.wire,
      searchSent: vi.fn((input: Parameters<SmtpWirePort['searchSent']>[0]) =>
        Promise.resolve({
          matches: [41, 42].map((uid) => ({
            folder: 'Sent',
            uidValidity: '900',
            uid,
            messageId: input.binding.messageId,
            envelopeFingerprint: input.binding.envelopeFingerprint,
            renderedPayloadHash: input.binding.renderedPayloadHash,
            observedAt: '2026-07-17T12:02:00.000Z',
          })),
          conclusiveAbsence: false,
          providerResponseHash: 'b'.repeat(64),
          observedAt: '2026-07-17T12:02:00.000Z',
        }),
      ),
    };
    await expect(
      reconcileSmtpSent({
        port: ambiguous,
        account: artifact.account,
        artifact,
        maxProviderQueries: 2,
      }),
    ).resolves.toMatchObject({
      outcome: 'acceptance_unknown',
      reasonCode: 'sent_reconciliation_ambiguous',
    });
  });
});
