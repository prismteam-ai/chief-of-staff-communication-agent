import { describe, expect, it, vi } from 'vitest';

import {
  pollImapUidCheckpoint,
  type ImapPollSession,
  type ImapSessionFactory,
} from './checkpoint.js';

function session(input?: {
  readonly uidValidity?: string;
  readonly messages?: readonly {
    readonly uid: number;
    readonly raw: Uint8Array;
  }[];
  readonly selectError?: Error;
}): ImapPollSession {
  return {
    select: vi.fn((folder: string) => {
      if (input?.selectError !== undefined) {
        return Promise.reject(input.selectError);
      }
      return Promise.resolve({
        folder,
        uidValidity: input?.uidValidity ?? '55',
        uidNext: 100,
      });
    }),
    fetchUidRange: vi.fn(() => Promise.resolve(input?.messages ?? [])),
    close: vi.fn(() => Promise.resolve()),
  };
}

const checkpoint = {
  schemaVersion: '1' as const,
  folder: 'INBOX',
  uidValidity: '55',
  nextUid: 10,
  highestSeenUid: 9,
};

describe('bounded IMAP UID checkpoint polling', () => {
  it('sorts and bounds UIDs and advances only to the last fetched UID', async () => {
    const current = session({
      messages: [
        { uid: 12, raw: Uint8Array.from([12]) },
        { uid: 10, raw: Uint8Array.from([10]) },
        { uid: 11, raw: Uint8Array.from([11]) },
      ],
    });
    const result = await pollImapUidCheckpoint({
      factory: { connect: () => Promise.resolve(current) },
      checkpoint,
      maxItems: 2,
      maxReconnects: 0,
    });
    expect(result.status).toBe('complete');
    expect(result.messages.map(({ uid }) => uid)).toEqual([10, 11]);
    expect(result.checkpoint).toMatchObject({
      nextUid: 12,
      highestSeenUid: 11,
    });
  });

  it('requires reset without consuming old UIDs when UIDVALIDITY changes', async () => {
    const result = await pollImapUidCheckpoint({
      factory: {
        connect: () => Promise.resolve(session({ uidValidity: '77' })),
      },
      checkpoint,
      maxItems: 10,
      maxReconnects: 0,
    });
    expect(result).toMatchObject({
      status: 'reset_required',
      messages: [],
      previousUidValidity: '55',
      checkpoint: { uidValidity: '77', nextUid: 1, highestSeenUid: 0 },
    });
  });

  it('reconnects within an explicit budget and always closes sessions', async () => {
    const first = session({ selectError: new Error('wire disconnected') });
    const second = session({
      messages: [{ uid: 10, raw: Uint8Array.from([1]) }],
    });
    const sessions = [first, second];
    const factory: ImapSessionFactory = {
      connect: vi.fn(() => {
        const next = sessions.shift();
        if (next === undefined) {
          return Promise.reject(new Error('unexpected connect'));
        }
        return Promise.resolve(next);
      }),
    };
    const result = await pollImapUidCheckpoint({
      factory,
      checkpoint,
      maxItems: 10,
      maxReconnects: 1,
    });
    expect(result.reconnectCount).toBe(1);
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });
});
