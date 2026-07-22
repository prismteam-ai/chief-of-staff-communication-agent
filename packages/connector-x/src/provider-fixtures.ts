export const LEGACY_DM_LOOKUP_FIXTURE_JSON =
  '{"data":[{"id":"1900000000000000001","event_type":"MessageCreate","text":"Quarterly review at 15:00?","sender_id":"2244994945","dm_conversation_id":"2244994945-6253282","created_at":"2026-07-16T10:15:00.000Z"},{"id":"1900000000000000001","event_type":"MessageCreate","text":"Quarterly review at 15:00?","sender_id":"2244994945","dm_conversation_id":"2244994945-6253282","created_at":"2026-07-16T10:15:00.000Z"},{"id":"1890000000000000002","event_type":"MessageCreate","text":"Within the bounded horizon","sender_id":"6253282","dm_conversation_id":"2244994945-6253282","created_at":"2026-06-20T09:00:00.000Z"},{"id":"1800000000000000003","event_type":"MessageCreate","text":"Outside the bounded horizon","sender_id":"2244994945","dm_conversation_id":"2244994945-6253282","created_at":"2026-05-01T09:00:00.000Z"}],"includes":{"users":[{"id":"2244994945","name":"Fixture Sender","username":"fixture_sender"},{"id":"6253282","name":"Fixture Recipient","username":"fixture_recipient"}]},"meta":{"result_count":4,"next_token":"fixture-page-2"}}';

export const LEGACY_DM_ACTIVITY_FIXTURE_JSON =
  '{"for_user_id":"6253282","events":[{"event_type":"dm.received","id":"activity-dm-1","created_at":"2026-07-16T10:15:01.000Z","dm_event":{"dm_event_id":"1900000000000000001","dm_conversation_id":"2244994945-6253282","sender_id":"2244994945"}},{"event_type":"dm.received","id":"activity-dm-1","created_at":"2026-07-16T10:15:01.000Z","dm_event":{"dm_event_id":"1900000000000000001","dm_conversation_id":"2244994945-6253282","sender_id":"2244994945"}}]}';

export const XCHAT_ACTIVITY_FIXTURE_JSON =
  '{"for_user_id":"6253282","events":[{"event_type":"chat.received","id":"activity-chat-1","created_at":"2026-07-16T10:16:00.000Z","chat_event":{"conversation_id":"encrypted-conversation-1","sender_id":"2244994945"}},{"event_type":"chat.conversation_join","id":"activity-chat-2","created_at":"2026-07-16T10:16:30.000Z","chat_event":{"conversation_id":"encrypted-conversation-1","sender_id":"6253282"}}]}';

export function fixtureBytes(exactJson: string): Uint8Array {
  return new TextEncoder().encode(exactJson);
}

export function parseFixtureJson(exactJson: string): unknown {
  return JSON.parse(exactJson) as unknown;
}
