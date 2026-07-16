import { describe, expect, it, vi } from 'vitest';
import type { DedupeRepo } from './dedupe-repo.js';
import type { CommunicationsRepo, CommunicationRecord } from './communications-repo.js';
import type { RawArtifactStore } from './raw-artifact-store.js';
import { processOneMessage, type FetchGmailAttachment, type FetchGmailMessage } from './processor-logic.js';

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

const ATTACHMENT_ID = 'ANGjdJ_attachment-001-vendor-agreement';
const ATTACHMENT_BODY_TEXT = 'Hello from a small fixture PDF-ish attachment body';
const ATTACHMENT_BASE64URL = Buffer.from(ATTACHMENT_BODY_TEXT).toString('base64url');

// Same shape, plus one small leaf part carrying an attachmentId — exercises the fetch-bytes path.
const messageWithAttachment = {
  id: MESSAGE_ID,
  threadId: MESSAGE_ID,
  internalDate: '1752577200000',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Marta Kowalczyk <marta.kowalczyk@brightpath-vendors.com>' },
      { name: 'To', value: 'Alex Rivera <demoalex775@gmail.com>' },
    ],
    body: { size: 0 },
    parts: [
      { partId: '0', mimeType: 'text/plain', body: { data: 'SGVsbG8gQWxleA' } },
      {
        partId: '1',
        mimeType: 'application/pdf',
        filename: 'vendor-agreement-signed.pdf',
        body: { attachmentId: ATTACHMENT_ID, size: ATTACHMENT_BODY_TEXT.length },
      },
    ],
  },
};

const noopLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeDeps(overrides: {
  dedupeClaims?: boolean;
  fetchMessage?: FetchGmailMessage;
  fetchAttachment?: FetchGmailAttachment;
} = {}) {
  const fetchMessage: FetchGmailMessage =
    overrides.fetchMessage ?? (async () => simpleMessage as never);

  const fetchAttachment: FetchGmailAttachment =
    overrides.fetchAttachment ?? vi.fn(async () => ATTACHMENT_BASE64URL);

  const dedupeRepo: DedupeRepo = { claim: vi.fn().mockResolvedValue(overrides.dedupeClaims ?? true) };

  const putIngested = vi.fn().mockImplementation(async (message) => ({
    ...message,
    commId: `${message.channelType}#${message.externalId}`,
    status: 'ingested',
    ingestedAt: '2026-07-16T00:00:00.000Z',
  }) satisfies CommunicationRecord);
  const communicationsRepo: CommunicationsRepo = { putIngested, getById: vi.fn() };

  const rawArtifactStore: RawArtifactStore = {
    putRawMessage: vi.fn().mockResolvedValue('gmail/x/raw.json'),
    putAttachment: vi.fn().mockImplementation(async (key: string) => key),
  };

  const metricsClient = { addMetric: vi.fn(), addDimension: vi.fn() };

  return {
    fetchMessage,
    fetchAttachment,
    dedupeRepo,
    communicationsRepo,
    rawArtifactStore,
    log: noopLog,
    metricsClient,
  };
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

  it('fetches and persists attachment bytes, recording the real S3 key on the communication record', async () => {
    const deps = makeDeps({ fetchMessage: async () => messageWithAttachment as never });

    const result = await processOneMessage({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }, deps);

    expect(result.outcome).toBe('ingested');
    expect(deps.rawArtifactStore.putAttachment).toHaveBeenCalledTimes(1);

    const [key, bytes, contentType] = (deps.rawArtifactStore.putAttachment as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, Buffer, string];
    expect(key).toBe(`raw/${ACCOUNT_ID}/${MESSAGE_ID}/attachments/${ATTACHMENT_ID}`);
    expect(bytes.toString('utf-8')).toBe(ATTACHMENT_BODY_TEXT);
    expect(contentType).toBe('application/pdf');

    const [record] = (deps.communicationsRepo.putIngested as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { attachments: { id: string; s3Key: string }[] },
    ];
    expect(record.attachments).toHaveLength(1);
    expect(record.attachments[0]?.s3Key).toBe(`raw/${ACCOUNT_ID}/${MESSAGE_ID}/attachments/${ATTACHMENT_ID}`);
  });

  it('skips fetching/persisting an attachment over the 10MB size guard, but still ingests the message', async () => {
    const oversized = {
      ...messageWithAttachment,
      payload: {
        ...messageWithAttachment.payload,
        parts: [
          messageWithAttachment.payload.parts[0],
          {
            ...messageWithAttachment.payload.parts[1],
            body: { attachmentId: ATTACHMENT_ID, size: 11 * 1024 * 1024 },
          },
        ],
      },
    };
    const deps = makeDeps({ fetchMessage: async () => oversized as never });

    const result = await processOneMessage({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }, deps);

    expect(result.outcome).toBe('ingested');
    expect(deps.fetchAttachment).not.toHaveBeenCalled();
    expect(deps.rawArtifactStore.putAttachment).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalledWith(
      'Skipping attachment over size guard — not fetched or persisted',
      expect.objectContaining({ attachmentId: ATTACHMENT_ID }),
    );
  });

  it('does not fail the whole message when a single attachment fetch fails', async () => {
    const deps = makeDeps({
      fetchMessage: async () => messageWithAttachment as never,
      fetchAttachment: async () => {
        throw new Error('Gmail attachments.get 500');
      },
    });

    const result = await processOneMessage({ accountId: ACCOUNT_ID, messageId: MESSAGE_ID }, deps);

    expect(result.outcome).toBe('ingested');
    expect(deps.rawArtifactStore.putAttachment).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalledWith(
      'Failed to fetch/persist one attachment — message ingest continues',
      expect.objectContaining({ attachmentId: ATTACHMENT_ID, error: 'Gmail attachments.get 500' }),
    );
    expect(deps.metricsClient.addMetric).toHaveBeenCalledWith('MessageIngested', 'Count', 1);
    expect(deps.metricsClient.addMetric).not.toHaveBeenCalledWith('MessageFailed', 'Count', 1);
  });
});
