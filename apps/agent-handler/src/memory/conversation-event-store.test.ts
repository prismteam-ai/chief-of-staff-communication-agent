import { describe, expect, it } from 'vitest';
import {
  CreateEventCommand,
  ListEventsCommand,
  type BedrockAgentCoreClient,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  AgentCoreConversationEventStore,
  NoopConversationEventStore,
  sanitizeAgentCoreKey,
  type ConversationEvent,
} from './conversation-event-store.js';

describe('sanitizeAgentCoreKey', () => {
  it('maps an email actor into the AgentCore-allowed charset', () => {
    // `@` and `.` are disallowed by AgentCore's actorId/sessionId regex — must be replaced.
    expect(sanitizeAgentCoreKey('demoalex775@gmail.com')).toBe('demoalex775_gmail_com');
    expect(/^[a-zA-Z0-9][a-zA-Z0-9-_/]*$/.test(sanitizeAgentCoreKey('demoalex775@gmail.com'))).toBe(
      true,
    );
  });

  it('maps a thread key containing # into the allowed charset', () => {
    expect(sanitizeAgentCoreKey('gmail#19f6aff00ee81d98')).toBe('gmail_19f6aff00ee81d98');
  });

  it('is deterministic and leaves an already-valid key unchanged', () => {
    expect(sanitizeAgentCoreKey('thread-1')).toBe('thread-1');
    expect(sanitizeAgentCoreKey('thread-1')).toBe(sanitizeAgentCoreKey('thread-1'));
  });
});

describe('NoopConversationEventStore', () => {
  it('never throws when memory is unconfigured — loads empty, appends nothing', async () => {
    const store = new NoopConversationEventStore();
    await expect(store.loadSessionEvents('s', 'a')).resolves.toEqual([]);
    await expect(
      store.appendEvents('s', 'a', [{ kind: 'user', at: '2026-07-16T00:00:00.000Z', text: 'hi' }], {
        clientTokenFor: () => 'tok',
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * A minimal fake `BedrockAgentCoreClient` that records the commands it was sent, so we can assert
 * the deterministic clientToken derivation without a real AWS call. `aws-sdk-client-mock` could mock
 * the client too, but the store already accepts an injectable client — the smaller seam is clearer.
 */
class FakeAgentCoreClient {
  public readonly sent: Array<CreateEventCommand | ListEventsCommand> = [];
  async send(
    command: CreateEventCommand | ListEventsCommand,
  ): Promise<{ events?: []; nextToken?: undefined }> {
    this.sent.push(command);
    // Emulate an empty ListEvents page so loadSessionEvents terminates.
    return { events: [], nextToken: undefined };
  }
}

function makeStore(fake: FakeAgentCoreClient) {
  return new AgentCoreConversationEventStore({
    memoryId: 'mem-1',
    historyLimit: 200,
    client: fake as unknown as BedrockAgentCoreClient,
  });
}

describe('AgentCoreConversationEventStore', () => {
  it('appends with deterministic clientTokens derived from message id + ordinal', async () => {
    const fake = new FakeAgentCoreClient();
    const store = makeStore(fake);

    const events: ConversationEvent[] = [
      { kind: 'user', at: '2026-07-16T00:00:00.000Z', text: 'question' },
      { kind: 'assistant', at: '2026-07-16T00:00:01.000Z', text: 'answer' },
    ];

    await store.appendEvents('thread-1', 'sender@example.com', events, {
      clientTokenFor: (_e, ordinal) => `msg-123:${ordinal}`,
    });

    const createCommands = fake.sent.filter(
      (c): c is CreateEventCommand => c instanceof CreateEventCommand,
    );
    expect(createCommands).toHaveLength(2);
    expect(createCommands[0]!.input.clientToken).toBe('msg-123:0');
    expect(createCommands[1]!.input.clientToken).toBe('msg-123:1');
    // Session/actor are sanitized into the AgentCore-allowed charset (email `@`/`.` → `_`).
    expect(createCommands[0]!.input.sessionId).toBe('thread-1');
    expect(createCommands[0]!.input.actorId).toBe('sender_example_com');
  });

  it('loadSessionEvents issues a ListEvents with the session/actor and returns [] on an empty page', async () => {
    const fake = new FakeAgentCoreClient();
    const store = makeStore(fake);

    const loaded = await store.loadSessionEvents('thread-1', 'sender@example.com');
    expect(loaded).toEqual([]);

    const listCommands = fake.sent.filter(
      (c): c is ListEventsCommand => c instanceof ListEventsCommand,
    );
    expect(listCommands).toHaveLength(1);
    expect(listCommands[0]!.input.sessionId).toBe('thread-1');
    expect(listCommands[0]!.input.actorId).toBe('sender_example_com');
    expect(listCommands[0]!.input.includePayloads).toBe(true);
  });
});
