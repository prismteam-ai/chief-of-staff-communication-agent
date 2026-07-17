import {
  contactChannelPolicySchema,
  effectExecutionArtifactSchema,
  suppressionFactSchema,
} from '@chief/contracts/approval';
import type {
  ContactChannelPolicy,
  EffectExecutionArtifact,
  SuppressionFact,
} from '@chief/contracts/approval';
import type { ConnectorDescriptor } from '@chief/contracts/connectors';

import type { TwilioInboundMessage } from './normalization.js';

export interface TwilioPolicyFactScope {
  readonly tenantId: string;
  readonly contactIdentityDigest: string;
  readonly connectorAccountId: string;
  readonly brandId: string;
}

export type TwilioPolicyFactResult =
  | { readonly kind: 'fact'; readonly fact: SuppressionFact }
  | { readonly kind: 'not_applicable'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string };

function factId(message: TwilioInboundMessage, suffix: string): string {
  return `twilio:${message.messageSid}:${suffix}`;
}

export function twilioSmsOptOutFact(input: {
  readonly message: TwilioInboundMessage;
  readonly scope: TwilioPolicyFactScope;
  readonly currentProviderOptOutFactId?: string;
}): TwilioPolicyFactResult {
  if (input.message.channel !== 'sms') {
    return { kind: 'not_applicable', reason: 'not an SMS event' };
  }
  if (input.message.optOutType === undefined) {
    return {
      kind: 'unknown',
      reason:
        'body text alone does not prove account-current provider STOP/START handling',
    };
  }
  if (input.message.optOutType === 'HELP') {
    return { kind: 'not_applicable', reason: 'HELP does not change consent' };
  }
  if (
    input.message.optOutType === 'START' &&
    input.currentProviderOptOutFactId === undefined
  ) {
    return {
      kind: 'unknown',
      reason: 'START cannot clear an unbound or cross-scope suppression',
    };
  }
  return {
    kind: 'fact',
    fact: suppressionFactSchema.parse({
      schemaVersion: '1',
      ...input.scope,
      factId: factId(input.message, input.message.optOutType.toLowerCase()),
      channel: 'sms',
      kind:
        input.message.optOutType === 'STOP'
          ? 'provider_opt_out'
          : 'verified_reconsent',
      authority: 'provider',
      providerEventId: input.message.messageSid,
      rawEventRef: `twilio-raw:${input.message.rawPayloadDigest}`,
      effectiveAt: input.message.sourceTimestamp,
      ...(input.currentProviderOptOutFactId === undefined
        ? {}
        : { supersedesFactId: input.currentProviderOptOutFactId }),
    }),
  };
}

export function twilioWhatsAppOptInFact(input: {
  readonly message: TwilioInboundMessage;
  readonly scope: TwilioPolicyFactScope;
  readonly evidence: 'explicit_user_opt_in';
}): SuppressionFact {
  if (input.message.channel !== 'whatsapp') {
    throw new Error('TWILIO_WHATSAPP_OPT_IN_CHANNEL_MISMATCH');
  }
  return suppressionFactSchema.parse({
    schemaVersion: '1',
    ...input.scope,
    factId: factId(input.message, 'explicit-opt-in'),
    channel: 'whatsapp',
    kind: 'verified_opt_in',
    authority: 'provider',
    providerEventId: input.message.messageSid,
    rawEventRef: `twilio-raw:${input.message.rawPayloadDigest}`,
    effectiveAt: input.message.sourceTimestamp,
  });
}

export function twilioWhatsAppWindowFact(input: {
  readonly message: TwilioInboundMessage;
  readonly scope: TwilioPolicyFactScope;
}): SuppressionFact {
  if (input.message.channel !== 'whatsapp') {
    throw new Error('TWILIO_WHATSAPP_WINDOW_CHANNEL_MISMATCH');
  }
  const expiresAt = new Date(
    Date.parse(input.message.sourceTimestamp) + 24 * 60 * 60 * 1_000,
  ).toISOString();
  return suppressionFactSchema.parse({
    schemaVersion: '1',
    ...input.scope,
    factId: factId(input.message, 'window-open'),
    channel: 'whatsapp',
    kind: 'window_open',
    authority: 'provider',
    providerEventId: input.message.messageSid,
    rawEventRef: `twilio-raw:${input.message.rawPayloadDigest}`,
    effectiveAt: input.message.sourceTimestamp,
    expiresAt,
  });
}

export function twilioWhatsAppWindowClosedFact(input: {
  readonly message: TwilioInboundMessage;
  readonly scope: TwilioPolicyFactScope;
  readonly openWindowFactId: string;
}): SuppressionFact {
  if (input.message.channel !== 'whatsapp') {
    throw new Error('TWILIO_WHATSAPP_WINDOW_CHANNEL_MISMATCH');
  }
  const effectiveAt = new Date(
    Date.parse(input.message.sourceTimestamp) + 24 * 60 * 60 * 1_000,
  ).toISOString();
  return suppressionFactSchema.parse({
    schemaVersion: '1',
    ...input.scope,
    factId: factId(input.message, 'window-closed'),
    channel: 'whatsapp',
    kind: 'window_closed',
    authority: 'provider',
    providerEventId: input.message.messageSid,
    rawEventRef: `twilio-raw:${input.message.rawPayloadDigest}`,
    effectiveAt,
    supersedesFactId: input.openWindowFactId,
  });
}

export interface TwilioApprovedTemplate {
  readonly templateId: string;
  readonly approvalEvidenceRef: string;
  readonly approvalState: 'approved';
}

export type TwilioSendEligibility =
  | {
      readonly eligible: true;
      readonly route: 'sms' | 'free_form' | 'template';
    }
  | {
      readonly eligible: false;
      readonly reason:
        | 'contact_policy_not_allowed'
        | 'verified_opt_in_missing'
        | 'customer_service_window_closed'
        | 'template_approval_missing';
    };

export function evaluateTwilioSendEligibility(
  input:
    | {
        readonly channel: 'sms';
        readonly policy: ContactChannelPolicy;
      }
    | {
        readonly channel: 'whatsapp';
        readonly policy: ContactChannelPolicy;
        readonly verifiedOptInFactId?: string;
        readonly template?: TwilioApprovedTemplate;
      },
): TwilioSendEligibility {
  const policy = contactChannelPolicySchema.parse(input.policy);
  if (policy.channel !== input.channel) {
    throw new Error('TWILIO_POLICY_CHANNEL_MISMATCH');
  }
  if (input.channel === 'sms') {
    return policy.state === 'allowed'
      ? { eligible: true, route: 'sms' }
      : { eligible: false, reason: 'contact_policy_not_allowed' };
  }
  if (
    input.verifiedOptInFactId === undefined ||
    !policy.applicableFactIds.some(
      (factId) => factId === input.verifiedOptInFactId,
    )
  ) {
    return { eligible: false, reason: 'verified_opt_in_missing' };
  }
  if (policy.state === 'allowed') {
    return { eligible: true, route: 'free_form' };
  }
  if (policy.state !== 'window_closed') {
    return { eligible: false, reason: 'contact_policy_not_allowed' };
  }
  if (input.template === undefined) {
    return { eligible: false, reason: 'customer_service_window_closed' };
  }
  if (
    input.template.approvalState !== 'approved' ||
    input.template.templateId.length === 0 ||
    input.template.approvalEvidenceRef.length === 0
  ) {
    return { eligible: false, reason: 'template_approval_missing' };
  }
  return { eligible: true, route: 'template' };
}

export interface TwilioEffectArtifactReceipt {
  readonly artifact: EffectExecutionArtifact;
  readonly route: 'sms' | 'free_form' | 'template';
  readonly externalEffect: false;
  readonly providerRequestCreated: false;
}

export function prepareTwilioEffectArtifact(input: {
  readonly descriptor: ConnectorDescriptor;
  readonly artifact: EffectExecutionArtifact;
  readonly eligibility: TwilioSendEligibility;
}): TwilioEffectArtifactReceipt {
  const artifact = effectExecutionArtifactSchema.parse(input.artifact);
  if (
    artifact.connectorSnapshot.connectorId !== input.descriptor.connectorId ||
    artifact.connectorSnapshot.descriptorVersion !==
      input.descriptor.descriptorVersion
  ) {
    throw new Error('TWILIO_EFFECT_ARTIFACT_CONNECTOR_MISMATCH');
  }
  if (!input.eligibility.eligible) {
    throw new Error(`TWILIO_SEND_DENIED:${input.eligibility.reason}`);
  }
  if (
    input.descriptor.capabilities.externalEffect ||
    input.descriptor.capabilities.send
  ) {
    throw new Error('TWILIO_EXTERNAL_EFFECT_NOT_DISABLED');
  }
  return Object.freeze({
    artifact,
    route: input.eligibility.route,
    externalEffect: false,
    providerRequestCreated: false,
  });
}
