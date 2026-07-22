import type { EffectExecutionArtifact } from '@chief/contracts/approval';
import type { PollRequest } from '@chief/contracts/connectors';

import { X_LEGACY_DM_CONNECTOR_ID } from './implementation-metadata.js';

const LEGACY_HISTORY_HORIZON_DAYS = 30;
const DAY_MILLISECONDS = 86_400_000;

export interface XLegacyDmEvent {
  readonly id: string;
  readonly event_type: string;
  readonly text?: string;
  readonly sender_id: string;
  readonly dm_conversation_id: string;
  readonly created_at: string;
  readonly attachments?: readonly Readonly<Record<string, unknown>>[];
}

export interface XLegacyDmLookupResponse {
  readonly data: readonly XLegacyDmEvent[];
  readonly includes?: {
    readonly users?: readonly {
      readonly id: string;
      readonly name: string;
      readonly username: string;
    }[];
  };
  readonly meta: {
    readonly result_count: number;
    readonly next_token?: string;
  };
}

export interface XLegacyDmCreateResponse {
  readonly data: {
    readonly dm_conversation_id: string;
    readonly dm_event_id: string;
  };
}

export interface XRequestShape {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
}

export interface XPollBudget {
  readonly remainingRequests: number;
  readonly remainingResources: number;
  readonly remainingCostUsd: number;
  readonly readResourceUnitCostUsd: number;
}

export interface NormalizedLegacyDmPage {
  readonly events: readonly XLegacyDmEvent[];
  readonly nextCursor?: string;
  readonly historyHorizonDays: 30;
  readonly duplicateCount: number;
  readonly excludedBeforeHorizon: number;
  readonly estimatedCostUsd: number;
}

export class XBudgetDeniedError extends Error {
  public constructor(public readonly reasonCode: string) {
    super(reasonCode);
    this.name = 'XBudgetDeniedError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`X_RESPONSE_INVALID_${field.toUpperCase()}`);
  }
  return candidate;
}

export function parseLegacyDmLookupResponse(
  raw: unknown,
): XLegacyDmLookupResponse {
  if (!isRecord(raw) || !Array.isArray(raw.data) || !isRecord(raw.meta)) {
    throw new Error('X_LOOKUP_RESPONSE_INVALID');
  }
  const resultCount = raw.meta.result_count;
  if (!Number.isInteger(resultCount) || Number(resultCount) < 0) {
    throw new Error('X_LOOKUP_RESULT_COUNT_INVALID');
  }
  const data = raw.data.map((candidate): XLegacyDmEvent => {
    if (!isRecord(candidate)) {
      throw new Error('X_DM_EVENT_INVALID');
    }
    const attachments = candidate.attachments;
    if (
      attachments !== undefined &&
      (!Array.isArray(attachments) || !attachments.every(isRecord))
    ) {
      throw new Error('X_DM_ATTACHMENTS_INVALID');
    }
    const event: XLegacyDmEvent = {
      id: requiredString(candidate, 'id'),
      event_type: requiredString(candidate, 'event_type'),
      sender_id: requiredString(candidate, 'sender_id'),
      dm_conversation_id: requiredString(candidate, 'dm_conversation_id'),
      created_at: requiredString(candidate, 'created_at'),
    };
    if (typeof candidate.text === 'string') {
      Object.assign(event, { text: candidate.text });
    }
    if (Array.isArray(attachments)) {
      Object.assign(event, { attachments });
    }
    if (Number.isNaN(Date.parse(event.created_at))) {
      throw new Error('X_DM_EVENT_TIMESTAMP_INVALID');
    }
    return event;
  });
  const response: XLegacyDmLookupResponse = {
    data,
    meta: {
      result_count: Number(resultCount),
    },
  };
  if (
    typeof raw.meta.next_token === 'string' &&
    raw.meta.next_token.length > 0
  ) {
    Object.assign(response.meta, { next_token: raw.meta.next_token });
  }
  if (isRecord(raw.includes) && Array.isArray(raw.includes.users)) {
    const users = raw.includes.users.map((candidate) => {
      if (!isRecord(candidate)) {
        throw new Error('X_LOOKUP_USER_INVALID');
      }
      return {
        id: requiredString(candidate, 'id'),
        name: requiredString(candidate, 'name'),
        username: requiredString(candidate, 'username'),
      };
    });
    Object.assign(response, { includes: { users } });
  }
  return response;
}

export function parseLegacyDmCreateResponse(
  raw: unknown,
): XLegacyDmCreateResponse {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    throw new Error('X_MANAGE_RESPONSE_INVALID');
  }
  return {
    data: {
      dm_conversation_id: requiredString(raw.data, 'dm_conversation_id'),
      dm_event_id: requiredString(raw.data, 'dm_event_id'),
    },
  };
}

export function buildLegacyDmLookupRequest(input: {
  readonly cursor?: string;
  readonly maxResults: number;
  readonly conversationId?: string;
  readonly participantId?: string;
}): XRequestShape {
  if (
    !Number.isInteger(input.maxResults) ||
    input.maxResults < 1 ||
    input.maxResults > 100
  ) {
    throw new Error('X_LOOKUP_MAX_RESULTS_INVALID');
  }
  if (input.cursor !== undefined && !input.cursor.startsWith('xlegacy:')) {
    throw new Error('X_LEGACY_CURSOR_NAMESPACE_MISMATCH');
  }
  if (input.conversationId !== undefined && input.participantId !== undefined) {
    throw new Error('X_LOOKUP_TARGET_AMBIGUOUS');
  }
  const path =
    input.conversationId !== undefined
      ? `/2/dm_conversations/${encodeURIComponent(input.conversationId)}/dm_events`
      : input.participantId !== undefined
        ? `/2/dm_conversations/with/${encodeURIComponent(input.participantId)}/dm_events`
        : '/2/dm_events';
  const query: Record<string, string> = {
    max_results: String(input.maxResults),
    'dm_event.fields':
      'id,event_type,text,sender_id,dm_conversation_id,created_at,attachments',
    expansions: 'sender_id,attachments.media_keys',
    'user.fields': 'id,name,username',
  };
  if (input.cursor !== undefined) {
    query.pagination_token = input.cursor.slice('xlegacy:'.length);
  }
  return { method: 'GET', path, query };
}

export interface XLegacyDmSendArtifact {
  readonly request: XRequestShape;
  readonly preDispatchBinding: {
    readonly operationId: string;
    readonly attemptId: string;
    readonly stableIdempotencyKey: string;
    readonly clientCorrelation: EffectExecutionArtifact['clientCorrelation'];
    readonly correlationBindingVersion: string;
    readonly renderedPayloadFingerprint: string;
  };
  readonly execution: 'effect_disabled';
}

export function buildLegacyDmSendArtifact(
  artifact: EffectExecutionArtifact,
  input: {
    readonly text: string;
    readonly conversationId?: string;
    readonly participantId?: string;
  },
): XLegacyDmSendArtifact {
  if (
    artifact.connectorSnapshot.connectorId !== X_LEGACY_DM_CONNECTOR_ID ||
    artifact.account.accountId !== artifact.connectorSnapshot.accountId ||
    artifact.tenantId !== artifact.account.tenantId
  ) {
    throw new Error('X_SEND_ARTIFACT_BINDING_MISMATCH');
  }
  if (
    artifact.clientCorrelation.kind !== 'client_reference' ||
    artifact.reconciliationStrategy !== 'x_legacy_dm_lookup'
  ) {
    throw new Error('X_SEND_CORRELATION_STRATEGY_MISMATCH');
  }
  if (
    (input.conversationId === undefined) ===
    (input.participantId === undefined)
  ) {
    throw new Error('X_SEND_TARGET_AMBIGUOUS');
  }
  if (input.text.length === 0) {
    throw new Error('X_SEND_TEXT_EMPTY');
  }
  const path =
    input.conversationId !== undefined
      ? `/2/dm_conversations/${encodeURIComponent(input.conversationId)}/messages`
      : `/2/dm_conversations/with/${encodeURIComponent(input.participantId ?? '')}/messages`;
  return {
    request: { method: 'POST', path, body: { text: input.text } },
    preDispatchBinding: {
      operationId: artifact.operationId,
      attemptId: artifact.attemptId,
      stableIdempotencyKey: artifact.stableIdempotencyKey,
      clientCorrelation: artifact.clientCorrelation,
      correlationBindingVersion: artifact.correlationBindingVersion,
      renderedPayloadFingerprint: artifact.renderedPayloadFingerprint,
    },
    execution: 'effect_disabled',
  };
}

export function normalizeLegacyDmPollPage(input: {
  readonly request: PollRequest;
  readonly response: XLegacyDmLookupResponse;
  readonly budget: XPollBudget;
  readonly now: string;
}): NormalizedLegacyDmPage {
  if (!input.request.checkpoint.encryptedCursor.startsWith('xlegacy:')) {
    throw new Error('X_LEGACY_CURSOR_NAMESPACE_MISMATCH');
  }
  if (input.budget.remainingRequests < 1) {
    throw new XBudgetDeniedError('X_RATE_BUDGET_DENIED');
  }
  const boundedResources = Math.min(
    input.response.data.length,
    input.request.maxItems,
  );
  const estimatedCostUsd =
    boundedResources * input.budget.readResourceUnitCostUsd;
  if (
    boundedResources > input.budget.remainingResources ||
    estimatedCostUsd > input.budget.remainingCostUsd
  ) {
    throw new XBudgetDeniedError('X_COST_BUDGET_DENIED');
  }
  const now = Date.parse(input.now);
  if (Number.isNaN(now)) {
    throw new Error('X_POLL_NOW_INVALID');
  }
  const cutoff = now - LEGACY_HISTORY_HORIZON_DAYS * DAY_MILLISECONDS;
  const seen = new Set<string>();
  const events: XLegacyDmEvent[] = [];
  let duplicateCount = 0;
  let excludedBeforeHorizon = 0;
  for (const event of input.response.data.slice(0, input.request.maxItems)) {
    if (seen.has(event.id)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(event.id);
    if (Date.parse(event.created_at) < cutoff) {
      excludedBeforeHorizon += 1;
      continue;
    }
    events.push(event);
  }
  events.sort(
    (left, right) =>
      Date.parse(left.created_at) - Date.parse(right.created_at) ||
      left.id.localeCompare(right.id),
  );
  const page: NormalizedLegacyDmPage = {
    events,
    historyHorizonDays: LEGACY_HISTORY_HORIZON_DAYS,
    duplicateCount,
    excludedBeforeHorizon,
    estimatedCostUsd,
  };
  if (input.response.meta.next_token !== undefined) {
    Object.assign(page, {
      nextCursor: `xlegacy:${input.response.meta.next_token}`,
    });
  }
  return page;
}
