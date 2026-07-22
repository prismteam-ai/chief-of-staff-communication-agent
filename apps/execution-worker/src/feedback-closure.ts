import type {
  ContactChannelPolicy,
  FeedbackContext,
  SuppressionFact,
  VerifiedFeedbackFact,
} from '@chief/contracts/approval';
import type { KeyedDigestValue, TenantId } from '@chief/contracts/ids';
import type { VerifiedProviderEvent } from '@chief/contracts/connectors';
import {
  processFeedback,
  type FeedbackAdapter,
  type FeedbackEventOutboxItem,
  type FeedbackPersistence,
  type FeedbackProcessingResult,
  type FeedbackPublisher,
} from '@chief/connector-core';
import { applyTransportFact, reduceContactPolicy } from '@chief/domain';
import type { SendAttempt } from '@chief/contracts/approval';

export interface FeedbackPolicyScope {
  readonly tenantId: TenantId;
  readonly contactIdentityDigest: KeyedDigestValue;
  readonly channel: string;
  readonly connectorAccountId: ContactChannelPolicy['connectorAccountId'];
  readonly brandId: ContactChannelPolicy['brandId'];
}

export interface FeedbackProjectionState {
  readonly attempt?: SendAttempt;
  readonly providerCorrelationDigest?: KeyedDigestValue;
  readonly policyScope?: FeedbackPolicyScope;
  readonly policyFacts: readonly SuppressionFact[];
  readonly currentPolicy?: ContactChannelPolicy;
}

export interface FeedbackClosurePersistence extends FeedbackPersistence {
  loadProjectionState(
    fact: VerifiedFeedbackFact,
  ): Promise<FeedbackProjectionState>;
  commitProjection(input: {
    readonly fact: VerifiedFeedbackFact;
    readonly attempt?: SendAttempt;
    readonly contactPolicy?: ContactChannelPolicy;
    readonly markAnswered: boolean;
  }): Promise<'created' | 'duplicate'>;
}

function assertProjectionBindings(
  fact: VerifiedFeedbackFact,
  state: FeedbackProjectionState,
): void {
  if (
    state.attempt !== undefined &&
    (state.attempt.tenantId !== fact.tenantId ||
      state.attempt.operationId !== fact.operationId ||
      state.attempt.attemptId !== fact.attemptId)
  ) {
    throw new Error('FEEDBACK_ATTEMPT_SCOPE_MISMATCH');
  }
  if (
    state.policyScope !== undefined &&
    (state.policyScope.tenantId !== fact.tenantId ||
      state.policyScope.connectorAccountId !== fact.connectorSnapshot.accountId)
  ) {
    throw new Error('FEEDBACK_POLICY_SCOPE_MISMATCH');
  }
}

function transportStateFor(
  kind: VerifiedFeedbackFact['feedbackKind'],
): SendAttempt['transportState'] | undefined {
  switch (kind) {
    case 'accepted':
      return 'provider_accepted';
    case 'delivered':
      return 'delivered';
    case 'delivery_failed':
      return 'delivery_failed';
    case 'bounced':
      return 'bounced';
    default:
      return undefined;
  }
}

function applyFeedbackTransport(input: {
  readonly fact: VerifiedFeedbackFact;
  readonly state: FeedbackProjectionState;
  readonly nextState: SendAttempt['transportState'];
}): SendAttempt | undefined {
  const attempt = input.state.attempt;
  if (attempt === undefined) return undefined;
  const correlation = input.state.providerCorrelationDigest;
  const needsAcceptanceBridge =
    attempt.transportState === 'queued' &&
    (input.nextState === 'delivered' ||
      input.nextState === 'delivery_failed' ||
      input.nextState === 'bounced');
  const accepted = needsAcceptanceBridge
    ? applyTransportFact({
        actorTenantId: input.fact.tenantId,
        attempt,
        nextState: 'provider_accepted',
        ...(correlation === undefined
          ? {}
          : { providerCorrelationDigest: correlation }),
      })
    : attempt;
  return applyTransportFact({
    actorTenantId: input.fact.tenantId,
    attempt: accepted,
    nextState: input.nextState,
    ...(correlation === undefined
      ? {}
      : { providerCorrelationDigest: correlation }),
  });
}

function suppressionKindFor(
  kind: VerifiedFeedbackFact['feedbackKind'],
): SuppressionFact['kind'] | undefined {
  switch (kind) {
    case 'complaint':
      return 'complaint';
    case 'unsubscribe':
      return 'unsubscribe';
    case 'opt_out':
      return 'provider_opt_out';
    case 'reconsent':
      return 'verified_reconsent';
    case 'window_opened':
      return 'window_open';
    case 'window_closed':
      return 'window_closed';
    case 'bounced':
      return 'bounce';
    default:
      return undefined;
  }
}

function toSuppressionFact(
  fact: VerifiedFeedbackFact,
  state: FeedbackProjectionState,
): SuppressionFact | undefined {
  const kind = suppressionKindFor(fact.feedbackKind);
  const scope = state.policyScope;
  if (kind === undefined || scope === undefined) return undefined;
  const supersedesFactId =
    kind === 'verified_reconsent'
      ? [...state.policyFacts]
          .reverse()
          .find(
            (candidate) =>
              candidate.kind === 'provider_opt_out' ||
              candidate.kind === 'unsubscribe',
          )?.factId
      : kind === 'window_open'
        ? [...state.policyFacts]
            .reverse()
            .find((candidate) => candidate.kind === 'window_closed')?.factId
        : undefined;
  return {
    schemaVersion: '1',
    ...scope,
    factId: fact.feedbackFactId,
    kind,
    authority: 'provider',
    ...(fact.providerEventId === undefined
      ? {}
      : { providerEventId: fact.providerEventId }),
    rawEventRef: fact.rawEventRef,
    effectiveAt: fact.providerTimestamp,
    ...(supersedesFactId === undefined ? {} : { supersedesFactId }),
  };
}

export interface FeedbackClosureResult {
  readonly processing: FeedbackProcessingResult;
  readonly projection?: 'created' | 'duplicate';
}

export async function processFeedbackClosure(input: {
  readonly adapter: FeedbackAdapter;
  readonly persistence: FeedbackClosurePersistence;
  readonly publisher: FeedbackPublisher;
  readonly event: VerifiedProviderEvent;
  readonly context: FeedbackContext;
  readonly observedAt: string;
  readonly reducerVersion: string;
}): Promise<FeedbackClosureResult> {
  let captured: VerifiedFeedbackFact | undefined;
  const capturingAdapter: FeedbackAdapter = {
    parseFeedbackEvent(event, context) {
      const parsed = input.adapter.parseFeedbackEvent(event, context);
      if (parsed.kind === 'verified') captured = parsed.fact;
      return parsed;
    },
  };
  const processing = await processFeedback(
    capturingAdapter,
    input.persistence,
    input.publisher,
    input.event,
    input.context,
    input.observedAt,
  );
  if (
    (processing.status !== 'persisted' && processing.status !== 'duplicate') ||
    captured === undefined
  ) {
    return { processing };
  }

  const fact = captured;
  const state = await input.persistence.loadProjectionState(fact);
  assertProjectionBindings(fact, state);
  const nextTransport = transportStateFor(fact.feedbackKind);
  const nextAttempt =
    nextTransport === undefined
      ? state.attempt
      : applyFeedbackTransport({ fact, state, nextState: nextTransport });
  const suppression = toSuppressionFact(fact, state);
  const nextPolicy =
    suppression === undefined
      ? state.currentPolicy
      : reduceContactPolicy({
          actorTenantId: fact.tenantId,
          facts: [...state.policyFacts, suppression],
          observedAt: input.observedAt,
          reducerVersion: input.reducerVersion,
          ...(state.currentPolicy === undefined
            ? {}
            : { previous: state.currentPolicy }),
        });
  const projection = await input.persistence.commitProjection({
    fact,
    ...(nextAttempt === undefined ? {} : { attempt: nextAttempt }),
    ...(nextPolicy === undefined ? {} : { contactPolicy: nextPolicy }),
    markAnswered: fact.feedbackKind === 'reply',
  });
  return { processing, projection };
}

export type { FeedbackEventOutboxItem };
