import { describe, expect, it, vi } from 'vitest';
import type { DedupeRepo } from './dedupe-repo.js';
import type { CommunicationsRepo, CommunicationRecord } from './communications-repo.js';
import type { RawArtifactStore } from './raw-artifact-store.js';
import { processOneMessage, type FetchGmailMessage } from './processor-logic.js';

const ACCOUNT_ID = 'acct_demo-alex-gmail';
const MESSAGE_ID = '18f2a1c3d4e5f601';

// A minimal but realistic Gmail `users.messages.get` response — this test exercises the
// processor's orchestration (dedupe -> S3 -> DynamoDB -> metrics), not Gmail normalization
// itself, which has its own fixture-backed suite in packages/connectors/src/gmail.
const simpleMessage = {
  id: MESSAGE_ID,
  threadId: MESSAGE_ID,
  internalDate: '1752577200000',
  payload: {
    headers: [
      { name: 'From', value: 'Priya Natarajan <priya.natarajan@northwind-consulting.com>' },
      { name: 'To', value: 'Alex Rivera <demoalex775@gmail.com>' },
    ],
    mimeType: 'text/plain',
    body: { data: 'SGVsbG8gQWxleA' },
  },
};

const noopLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeDeps(overrides: {
  dedupeClaims?: boolean;
  fetchMessage?: FetchGmailMessage;
} = {}) {
  const fetchMessage: FetchGmailMessage =
    overrides.fetchMessage ?? (async () => simpleMessage as never);

  const dedupeRepo: DedupeRepo = { claim: vi.fn().mockResolvedValue(overrides.dedupeClaims ?? true) };

  const putIngested = vi.fn().mockImplementation(async (message) => ({
    ...message,
    commId: `${message.channelType}#${message.externalId}`,
    status: 'ingested',
    ingestedAt: '2026-07-16T00:00:00.000Z',
  }) satisfies CommunicationRecord);
  const communicationsRepo: CommunicationsRepo = { putIngested, getById: vi.fn() };

  const rawArtifactStore: RawArtifactStore = { putRawMessage: vi.fn().mockResolvedValue('gmail/x/raw.json') };

  const metricsClient = { addMetric: vi.fn(), addDimension: vi.fn() };

  return { fetchMessage, dedupeRepo, communicationsRepo, rawArtifactStore, log: noopLog, metricsClient };
}

describe('processOneMessage', () => {
  it('fetches, normalizes, dedupes, persists raw + record, and emits MessageIngested', async () => {
    const deps = makeDeps();

    const result = await processOneMessage({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }, deps);

    expect(result).toEqual({ outcome: 'ingested', commId: 'gmail#18f2a1c3d4e5f601' });
    expect(deps.dedupeRepo.claim).toHaveBeenCalledWith('gmail#18f2a1c3d4e5f601');
    expect(deps.rawArtifactStore.putRawMessage).toHaveBeenCalledWith('gmail', '18f2a1c3d4e5f601', simpleMessage);
    expect(deps.communicationsRepo.putIngested).toHaveBeenCalledTimes(1);
    expect(deps.metricsClient.addMetric).toHaveBeenCalledWith('MessageIngested', 'Count', 1);
    expect(deps.metricsClient.addDimension).toHaveBeenCalledWith('channel', 'gmail');
  });

  it('skips persistence when the dedupe claim is lost (a duplicate delivery)', async () => {
    const deps = makeDeps({ dedupeClaims: false });

    const result = await processOneMessage({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }, deps);

    expect(result).toEqual({ outcome: 'duplicate', dedupeKey: 'gmail#18f2a1c3d4e5f601' });
    expect(deps.rawArtifactStore.putRawMessage).not.toHaveBeenCalled();
    expect(deps.communicationsRepo.putIngested).not.toHaveBeenCalled();
    expect(deps.metricsClient.addMetric).not.toHaveBeenCalledWith('MessageIngested', 'Count', 1);
  });

  it('claims dedupe before persisting anything (ordering matters for idempotency)', async () => {
    const callOrder: string[] = [];
    const deps = makeDeps();
    deps.dedupeRepo.claim = vi.fn().mockImplementation(async () => {
      callOrder.push('dedupe');
      return true;
    });
    deps.rawArtifactStore.putRawMessage = vi.fn().mockImplementation(async () => {
      callOrder.push('s3');
      return 'key';
    });
    deps.communicationsRepo.putIngested = vi.fn().mockImplementation(async (m) => {
      callOrder.push('dynamo');
      return { ...m, commId: 'gmail#x', status: 'ingested', ingestedAt: 'now' } as CommunicationRecord;
    });

    await processOneMessage({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }, deps);

    expect(callOrder).toEqual(['dedupe', 's3', 'dynamo']);
  });

  it('returns a failed outcome and emits MessageFailed when fetch throws', async () => {
    const deps = makeDeps({
      fetchMessage: async () => {
        throw new Error('Gmail API 500');
      },
    });

    const result = await processOneMessage({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }, deps);

    expect(result.outcome).toBe('failed');
    expect(deps.metricsClient.addMetric).toHaveBeenCalledWith('MessageFailed', 'Count', 1);
    expect(deps.dedupeRepo.claim).not.toHaveBeenCalled();
  });

  it('returns a failed outcome when normalization throws (malformed Gmail payload)', async () => {
    const deps = makeDeps({ fetchMessage: async () => ({ id: 'no-thread-id' }) as never });

    const result = await processOneMessage({ accountId: ACCOUNT_ID, messageId: 'no-thread-id' }, deps);

    expect(result.outcome).toBe('failed');
    expect(deps.metricsClient.addMetric).toHaveBeenCalledWith('MessageFailed', 'Count', 1);
  });
});
