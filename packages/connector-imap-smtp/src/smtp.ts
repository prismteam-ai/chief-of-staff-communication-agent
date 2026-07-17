import { createHash } from 'node:crypto';

import type {
  EffectExecutionArtifact,
  ProviderSendResult,
} from '@chief/contracts/approval';
import type { ConnectorAccountRef } from '@chief/contracts/connectors';

export interface RenderedSmtpMessage {
  readonly envelopeFrom: string;
  readonly envelopeTo: readonly string[];
  readonly raw: Uint8Array;
}

export interface SmtpCorrelationBinding {
  readonly schemaVersion: '1';
  readonly operationId: EffectExecutionArtifact['operationId'];
  readonly attemptId: EffectExecutionArtifact['attemptId'];
  readonly messageId: string;
  readonly envelopeFingerprint: string;
  readonly renderedPayloadHash: string;
  readonly correlationBindingVersion: string;
}

export type SmtpFinalReply =
  | {
      readonly kind: 'accepted';
      readonly code: number;
      readonly exactResponse: string;
      readonly serverQueueId?: string;
      readonly observedAt: string;
    }
  | {
      readonly kind: 'rejected';
      readonly code: number;
      readonly exactResponse: string;
      readonly observedAt: string;
    }
  | {
      readonly kind: 'inconclusive';
      readonly reason:
        | 'timeout_after_data'
        | 'disconnect_after_data'
        | 'malformed_final_reply';
      readonly exactResponse?: string;
      readonly observedAt: string;
    };

export interface SentFolderMatch {
  readonly folder: string;
  readonly uidValidity: string;
  readonly uid: number;
  readonly messageId: string;
  readonly envelopeFingerprint: string;
  readonly renderedPayloadHash: string;
  readonly observedAt: string;
}

export interface SmtpSentReconciliationResult {
  readonly matches: readonly SentFolderMatch[];
  readonly conclusiveAbsence: boolean;
  readonly providerResponseHash: string;
  readonly observedAt: string;
}

export interface SmtpWirePort {
  loadRenderedMessage(
    account: ConnectorAccountRef,
    artifact: EffectExecutionArtifact,
  ): Promise<RenderedSmtpMessage>;
  persistPreDataBinding(
    account: ConnectorAccountRef,
    binding: SmtpCorrelationBinding,
  ): Promise<void>;
  submitData(
    account: ConnectorAccountRef,
    binding: SmtpCorrelationBinding,
    message: RenderedSmtpMessage,
  ): Promise<SmtpFinalReply>;
  searchSent(input: {
    readonly account: ConnectorAccountRef;
    readonly binding: SmtpCorrelationBinding;
    readonly maxProviderQueries: number;
  }): Promise<SmtpSentReconciliationResult>;
}

export function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalAddress(value: string): string {
  const address = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/u.test(address)) {
    throw new Error('SMTP_ENVELOPE_ADDRESS_INVALID');
  }
  return address;
}

function rawMessageId(raw: Uint8Array): string | undefined {
  const header = Buffer.from(raw)
    .toString('utf8')
    .split(/\r?\n\r?\n/u, 1)[0]
    ?.replace(/\r?\n[ \t]+/gu, ' ');
  return header?.match(/^Message-ID:\s*(<[^<>\s]+@[^<>\s]+>)\s*$/imu)?.[1];
}

export function bindSmtpCorrelation(
  artifact: EffectExecutionArtifact,
  message: RenderedSmtpMessage,
): SmtpCorrelationBinding {
  if (
    artifact.clientCorrelation.kind !== 'rfc_message_id' ||
    !/^<[^<>\s@]+@[^<>\s@]+>$/u.test(artifact.clientCorrelation.value)
  ) {
    throw new Error('SMTP_RFC5322_MESSAGE_ID_REQUIRED');
  }
  if (rawMessageId(message.raw) !== artifact.clientCorrelation.value) {
    throw new Error('SMTP_MESSAGE_ID_BINDING_MISMATCH');
  }
  const renderedPayloadHash = sha256(message.raw);
  if (renderedPayloadHash !== artifact.renderedPayloadFingerprint) {
    throw new Error('SMTP_RENDERED_PAYLOAD_HASH_MISMATCH');
  }
  const envelopeFrom = canonicalAddress(message.envelopeFrom);
  const envelopeTo = [
    ...new Set(message.envelopeTo.map(canonicalAddress)),
  ].sort();
  if (envelopeTo.length === 0) {
    throw new Error('SMTP_ENVELOPE_RECIPIENT_REQUIRED');
  }
  return Object.freeze({
    schemaVersion: '1',
    operationId: artifact.operationId,
    attemptId: artifact.attemptId,
    messageId: artifact.clientCorrelation.value,
    envelopeFingerprint: sha256(`${envelopeFrom}\n${envelopeTo.join('\n')}`),
    renderedPayloadHash,
    correlationBindingVersion: artifact.correlationBindingVersion,
  });
}

function responseHash(reply: SmtpFinalReply): string | undefined {
  return reply.exactResponse === undefined
    ? undefined
    : sha256(reply.exactResponse);
}

export async function dispatchSmtpData(input: {
  readonly port: SmtpWirePort;
  readonly account: ConnectorAccountRef;
  readonly artifact: EffectExecutionArtifact;
}): Promise<ProviderSendResult> {
  const message = await input.port.loadRenderedMessage(
    input.account,
    input.artifact,
  );
  const binding = bindSmtpCorrelation(input.artifact, message);
  await input.port.persistPreDataBinding(input.account, binding);
  const reply = await input.port.submitData(input.account, binding, message);
  if (reply.kind === 'inconclusive') {
    return {
      outcome: 'acceptance_unknown',
      ...(responseHash(reply) === undefined
        ? {}
        : { providerResponseHash: responseHash(reply) }),
      reasonCode: reply.reason,
      observedAt: reply.observedAt,
    };
  }
  if (reply.kind === 'rejected' || reply.code < 200 || reply.code >= 300) {
    return {
      outcome: 'rejected',
      providerResponseHash: sha256(reply.exactResponse),
      reasonCode: `smtp_${reply.code}`,
      observedAt: reply.observedAt,
    };
  }
  if (reply.serverQueueId === undefined) {
    return {
      outcome: 'acceptance_unknown',
      providerResponseHash: sha256(reply.exactResponse),
      reasonCode: 'smtp_accepted_without_provider_correlation',
      observedAt: reply.observedAt,
    };
  }
  return {
    outcome: 'accepted',
    providerResponseHash: sha256(reply.exactResponse),
    providerCorrelation: reply.serverQueueId,
    observedAt: reply.observedAt,
  };
}

export async function reconcileSmtpSent(input: {
  readonly port: SmtpWirePort;
  readonly account: ConnectorAccountRef;
  readonly artifact: EffectExecutionArtifact;
  readonly maxProviderQueries: number;
}): Promise<ProviderSendResult> {
  const message = await input.port.loadRenderedMessage(
    input.account,
    input.artifact,
  );
  const binding = bindSmtpCorrelation(input.artifact, message);
  const result = await input.port.searchSent({
    account: input.account,
    binding,
    maxProviderQueries: input.maxProviderQueries,
  });
  const strongMatches = result.matches.filter(
    (match) =>
      match.messageId === binding.messageId &&
      match.envelopeFingerprint === binding.envelopeFingerprint &&
      match.renderedPayloadHash === binding.renderedPayloadHash,
  );
  if (strongMatches.length === 1) {
    const match = strongMatches[0];
    if (match === undefined) {
      throw new Error('SMTP_RECONCILIATION_INTERNAL_ERROR');
    }
    return {
      outcome: 'accepted',
      providerResponseHash: result.providerResponseHash,
      providerCorrelation: `imap-sent:${match.folder}:${match.uidValidity}:${match.uid}`,
      observedAt: result.observedAt,
    };
  }
  if (strongMatches.length === 0 && result.conclusiveAbsence) {
    return {
      outcome: 'rejected',
      providerResponseHash: result.providerResponseHash,
      reasonCode: 'sent_reconciliation_proves_absent',
      observedAt: result.observedAt,
    };
  }
  return {
    outcome: 'acceptance_unknown',
    providerResponseHash: result.providerResponseHash,
    reasonCode:
      strongMatches.length > 1
        ? 'sent_reconciliation_ambiguous'
        : 'sent_reconciliation_inconclusive',
    observedAt: result.observedAt,
  };
}
