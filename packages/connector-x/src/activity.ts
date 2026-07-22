export type XActivityNamespace = 'legacy_dm' | 'xchat_encrypted';

export interface XActivityEvent {
  readonly namespace: XActivityNamespace;
  readonly providerEventId: string;
  readonly eventType:
    | 'dm.received'
    | 'dm.sent'
    | 'dm.read'
    | 'chat.received'
    | 'chat.sent'
    | 'chat.conversation_join';
  readonly sourceTimestamp: string;
  readonly conversationId: string;
  readonly senderId?: string;
  readonly providerMessageId?: string;
  readonly plaintextAvailability: 'available' | 'unknown';
}

export type XActivityParseResult =
  | { readonly kind: 'parsed'; readonly event: XActivityEvent }
  | {
      readonly kind: 'unsupported';
      readonly fact: 'unknown';
      readonly reason: string;
    }
  | { readonly kind: 'invalid'; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof record[key] === 'string' && record[key].length > 0
    ? String(record[key])
    : undefined;
}

const legacyTypes = new Set(['dm.received', 'dm.sent', 'dm.read']);
const xChatTypes = new Set([
  'chat.received',
  'chat.sent',
  'chat.conversation_join',
]);

export function parseXActivityEvent(
  raw: unknown,
  expectedNamespace: XActivityNamespace,
): XActivityParseResult {
  if (!isRecord(raw)) {
    return { kind: 'invalid', reason: 'activity_event_not_object' };
  }
  const eventType = stringField(raw, 'event_type');
  const providerEventId = stringField(raw, 'id');
  const sourceTimestamp = stringField(raw, 'created_at');
  if (
    eventType === undefined ||
    providerEventId === undefined ||
    sourceTimestamp === undefined ||
    Number.isNaN(Date.parse(sourceTimestamp))
  ) {
    return {
      kind: 'invalid',
      reason: 'activity_event_required_fields_invalid',
    };
  }
  const actualNamespace = legacyTypes.has(eventType)
    ? 'legacy_dm'
    : xChatTypes.has(eventType)
      ? 'xchat_encrypted'
      : undefined;
  if (actualNamespace === undefined) {
    return {
      kind: 'unsupported',
      fact: 'unknown',
      reason: 'activity_namespace_unknown',
    };
  }
  if (actualNamespace !== expectedNamespace) {
    return {
      kind: 'unsupported',
      fact: 'unknown',
      reason: 'activity_namespace_mismatch',
    };
  }
  const detailKey = actualNamespace === 'legacy_dm' ? 'dm_event' : 'chat_event';
  const detail = raw[detailKey];
  if (!isRecord(detail)) {
    return { kind: 'invalid', reason: `${detailKey}_missing` };
  }
  const conversationId = stringField(
    detail,
    actualNamespace === 'legacy_dm' ? 'dm_conversation_id' : 'conversation_id',
  );
  if (conversationId === undefined) {
    return { kind: 'invalid', reason: 'activity_conversation_missing' };
  }
  const event: XActivityEvent = {
    namespace: actualNamespace,
    providerEventId,
    eventType: eventType as XActivityEvent['eventType'],
    sourceTimestamp,
    conversationId,
    plaintextAvailability:
      actualNamespace === 'xchat_encrypted' ? 'unknown' : 'available',
  };
  const senderId = stringField(detail, 'sender_id');
  const providerMessageId = stringField(detail, 'dm_event_id');
  if (senderId !== undefined) Object.assign(event, { senderId });
  if (providerMessageId !== undefined)
    Object.assign(event, { providerMessageId });
  return { kind: 'parsed', event };
}

export function deduplicateXActivityEvents(events: readonly XActivityEvent[]): {
  readonly events: readonly XActivityEvent[];
  readonly duplicateCount: number;
} {
  const seen = new Set<string>();
  const unique: XActivityEvent[] = [];
  let duplicateCount = 0;
  for (const event of events) {
    const key = `${event.namespace}:${event.providerEventId}`;
    if (seen.has(key)) {
      duplicateCount += 1;
    } else {
      seen.add(key);
      unique.push(event);
    }
  }
  unique.sort(
    (left, right) =>
      Date.parse(left.sourceTimestamp) - Date.parse(right.sourceTimestamp) ||
      left.providerEventId.localeCompare(right.providerEventId),
  );
  return { events: unique, duplicateCount };
}
