import { describe, expect, it } from 'vitest';
import { chunkIdFor, chunkNormalizedMessage } from './chunk.js';
import type { NormalizedMessage } from '@chief-of-staff/shared';

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    schemaVersion: 1,
    channelType: 'gmail',
    accountId: 'acct_alex',
    externalId: 'msg-1',
    threadKey: 'thread-1',
    participants: [
      { id: 'alex@brand-a.com', displayName: 'Alex Rivera', role: 'from' },
      { id: 'sam@vendor.io', displayName: 'Sam Cho', role: 'to' },
    ],
    ts: '2026-07-10T14:30:00.000Z',
    body: 'Can we push the Meridian contract review to Thursday?',
    attachments: [],
    ...overrides,
  };
}

describe('chunkIdFor', () => {
  it('is deterministic — same source id + idx + content produce the same id', () => {
    const a = chunkIdFor('gmail#msg-1', 0, 'hello world');
    const b = chunkIdFor('gmail#msg-1', 0, 'hello world');
    expect(a).toBe(b);
  });

  it('changes when the content changes even with the same source id and index', () => {
    const original = chunkIdFor('gmail#msg-1', 0, 'hello world');
    const edited = chunkIdFor('gmail#msg-1', 0, 'hello world!!!');
    expect(edited).not.toBe(original);
  });

  it('changes when only the chunk index changes', () => {
    const first = chunkIdFor('gmail#msg-1', 0, 'same content');
    const second = chunkIdFor('gmail#msg-1', 1, 'same content');
    expect(first).not.toBe(second);
  });

  it('changes when only the source id changes', () => {
    const one = chunkIdFor('gmail#msg-1', 0, 'same content');
    const two = chunkIdFor('gmail#msg-2', 0, 'same content');
    expect(one).not.toBe(two);
  });

  it('carries the human-readable source id and index as a prefix for debuggability', () => {
    // Composition is `<sourceId>#<idx>#<12-hex-of-sha256(content)>` — the prefix keeps ids
    // greppable back to their source while the hash makes a body edit produce a fresh id.
    const id = chunkIdFor('gmail#msg-1', 0, 'hello');
    expect(id).toMatch(/^gmail#msg-1#0#[0-9a-f]{12}$/);
  });
});

describe('chunkNormalizedMessage', () => {
  it('produces one whole-body chunk (v1 chunking) with both text fields populated', () => {
    const chunks = chunkNormalizedMessage(message());
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0]!;
    expect(chunk.textForEmbedding.length).toBeGreaterThan(0);
    expect(chunk.textForContext.length).toBeGreaterThan(0);
    expect(chunk.metadata.channel).toBe('gmail');
    expect(chunk.metadata.accountId).toBe('acct_alex');
    expect(chunk.metadata.sourceType).toBe('communication');
  });

  it('derives a deterministic chunk id from the comm id + index + content', () => {
    const chunk = chunkNormalizedMessage(message())[0]!;
    expect(chunk.chunkId).toBe(chunkIdFor('gmail#msg-1', 0, chunk.textForEmbedding));
  });

  it('carries participants and timestamp into metadata for cross-channel linking', () => {
    const chunk = chunkNormalizedMessage(message())[0]!;
    expect(chunk.metadata.participants).toEqual(['alex@brand-a.com', 'sam@vendor.io']);
    expect(chunk.metadata.ts).toBe('2026-07-10T14:30:00.000Z');
  });

  it('includes the subject line in the embedding text when a subject metadata line is present in the body', () => {
    // NormalizedMessage has no dedicated subject field (design.md §3 schema); the Gmail connector
    // folds the subject into the body. v1 chunking embeds the whole body, so a subject already in
    // the body is embedded. This test pins that the body text (subject-or-not) reaches the vector.
    const withSubject = message({ body: 'Subject: Meridian contract\n\nCan we push to Thursday?' });
    const chunk = chunkNormalizedMessage(withSubject)[0]!;
    expect(chunk.textForEmbedding).toContain('Meridian contract');
    expect(chunk.textForEmbedding).toContain('Thursday');
  });

  it('produces an empty chunk list for an empty body rather than an empty-vector chunk', () => {
    const empty = message({ body: '   ' });
    expect(chunkNormalizedMessage(empty)).toHaveLength(0);
  });
});
