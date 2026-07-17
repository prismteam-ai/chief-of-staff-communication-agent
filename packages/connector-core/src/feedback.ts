import { feedbackParseResultSchema } from '@chief/contracts/approval';
import type {
  FeedbackContext,
  FeedbackParseResult,
  VerifiedFeedbackFact,
} from '@chief/contracts/approval';
import type { VerifiedProviderEvent } from '@chief/contracts/connectors';

export type { FeedbackContext, FeedbackParseResult, VerifiedFeedbackFact };

export interface FeedbackEventOutboxItem {
  readonly eventId: string;
  readonly eventType: 'connector.feedback.v1';
  readonly factId: VerifiedFeedbackFact['feedbackFactId'];
  readonly tenantId: VerifiedFeedbackFact['tenantId'];
  readonly operationId?: VerifiedFeedbackFact['operationId'];
}

export interface FeedbackReplayItem {
  readonly replayId: string;
  readonly reason: 'uncorrelated' | 'persistence_failed';
  readonly event: VerifiedProviderEvent;
  readonly observedAt: string;
}

export interface FeedbackPersistence {
  persistFactAndOutbox(
    fact: VerifiedFeedbackFact,
    outbox: FeedbackEventOutboxItem,
  ): Promise<'created' | 'duplicate'>;
  persistReplay(item: FeedbackReplayItem): Promise<void>;
}

export interface FeedbackPublisher {
  publish(item: FeedbackEventOutboxItem): Promise<void>;
}

export interface FeedbackAdapter {
  parseFeedbackEvent(
    event: VerifiedProviderEvent,
    context: FeedbackContext,
  ): FeedbackParseResult;
}

export type FeedbackProcessingResult =
  | { readonly status: 'unsupported' | 'invalid'; readonly reason: string }
  | { readonly status: 'pending_replay'; readonly replayId: string }
  | {
      readonly status: 'persisted' | 'duplicate';
      readonly factId: VerifiedFeedbackFact['feedbackFactId'];
      readonly eventId: string;
    };

function sameSnapshot(
  left: FeedbackContext['connectorSnapshot'],
  right: FeedbackContext['connectorSnapshot'],
): boolean {
  return (
    left.connectorId === right.connectorId &&
    left.descriptorVersion === right.descriptorVersion &&
    left.accountId === right.accountId &&
    left.capabilitySnapshotHash === right.capabilitySnapshotHash &&
    left.runtimeMode === right.runtimeMode &&
    left.selectionState === right.selectionState
  );
}

function assertFeedbackBindings(
  fact: VerifiedFeedbackFact,
  event: VerifiedProviderEvent,
  context: FeedbackContext,
): void {
  const factHasLink =
    fact.operationId !== undefined || fact.attemptId !== undefined;
  const factHasCompleteLink =
    fact.operationId !== undefined && fact.attemptId !== undefined;
  const contextHasLink =
    context.knownOperationId !== undefined ||
    context.knownAttemptId !== undefined;
  const contextHasCompleteLink =
    context.knownOperationId !== undefined &&
    context.knownAttemptId !== undefined;
  if (
    fact.tenantId !== event.tenantId ||
    fact.tenantId !== context.tenantId ||
    context.account.tenantId !== context.tenantId ||
    context.account.accountId !== event.accountId ||
    context.connectorSnapshot.accountId !== context.account.accountId ||
    (fact.providerEventId !== undefined &&
      fact.providerEventId !== event.providerEventId) ||
    fact.rawEventRef !== event.rawEventRef ||
    fact.rawPayloadDigest !== event.rawPayloadDigest ||
    !sameSnapshot(event.connectorSnapshot, context.connectorSnapshot) ||
    !sameSnapshot(fact.connectorSnapshot, context.connectorSnapshot) ||
    (factHasLink && !factHasCompleteLink) ||
    (contextHasLink && !contextHasCompleteLink) ||
    (contextHasCompleteLink &&
      (fact.operationId !== context.knownOperationId ||
        fact.attemptId !== context.knownAttemptId))
  ) {
    throw new Error('FEEDBACK_BINDING_MISMATCH');
  }
}

export async function processFeedback(
  adapter: FeedbackAdapter,
  persistence: FeedbackPersistence,
  publisher: FeedbackPublisher,
  event: VerifiedProviderEvent,
  context: FeedbackContext,
  observedAt: string,
): Promise<FeedbackProcessingResult> {
  const parsed = feedbackParseResultSchema.parse(
    adapter.parseFeedbackEvent(event, context),
  );
  if (parsed.kind === 'unsupported' || parsed.kind === 'invalid') {
    return { status: parsed.kind, reason: parsed.reason };
  }

  const fact = parsed.fact;
  assertFeedbackBindings(fact, event, context);
  if (fact.operationId === undefined || fact.attemptId === undefined) {
    const replayId = `feedback:${fact.feedbackFactId}:uncorrelated`;
    await persistence.persistReplay({
      replayId,
      reason: 'uncorrelated',
      event,
      observedAt,
    });
    return { status: 'pending_replay', replayId };
  }

  const outbox: FeedbackEventOutboxItem = {
    eventId: `feedback-event:${fact.feedbackFactId}`,
    eventType: 'connector.feedback.v1',
    factId: fact.feedbackFactId,
    tenantId: fact.tenantId,
    operationId: fact.operationId,
  };

  let persisted: 'created' | 'duplicate';
  try {
    persisted = await persistence.persistFactAndOutbox(fact, outbox);
  } catch {
    const replayId = `feedback:${fact.feedbackFactId}:persistence_failed`;
    await persistence.persistReplay({
      replayId,
      reason: 'persistence_failed',
      event,
      observedAt,
    });
    return { status: 'pending_replay', replayId };
  }

  if (persisted === 'created') {
    await publisher.publish(outbox);
  }
  return {
    status: persisted === 'created' ? 'persisted' : 'duplicate',
    factId: fact.feedbackFactId,
    eventId: outbox.eventId,
  };
}
