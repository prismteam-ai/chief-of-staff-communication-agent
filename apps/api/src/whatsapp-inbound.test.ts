import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { RetrievalIndex } from '@chief-of-staff/rag';
import type { DedupeRepo } from './repos/dedupe-repo.js';
import type { CommunicationsRepo, ApiCommunicationRecord } from './repos/communications-repo.js';
import type { AgentTrigger } from './agent-trigger.js';
import {
  isValidTwilioRequest,
  processInboundWhatsAppWebhook,
  WHATSAPP_DEMO_ACCOUNT_ID,
} from './whatsapp-inbound.js';

// Same mock strategy as apps/ingest/src/processor-logic.test.ts: embedTexts is a real Bedrock
// call, mocked here so this suite exercises orchestration/isolation, not embedding itself.
vi.mock('@chief-of-staff/rag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chief-of-staff/rag')>();
  return { ...actual, embedTexts: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]) };
});

const AUTH_TOKEN = 'test-auth-token-abc123';
const WEBHOOK_URL = 'https://klxrwe0sa3.execute-api.us-east-2.amazonaws.com/whatsapp/inbound';

function signParams(authToken: string, url: string, formParams: Record<string, string>): string {
  const sortedKeys = Object.keys(formParams).sort();
  const data = sortedKeys.reduce((acc, key) => acc + key + formParams[key], url);
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

function twilioPayload(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: 'SM1234567890abcdef1234567890abcdef',
    From: 'whatsapp:+15551234567',
    To: 'whatsapp:+14155238886',
    Body: 'Can we push the Thursday sync to 3pm?',
    NumMedia: '0',
    ...overrides,
  };
}

const noopLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeDeps(
  overrides: {
    dedupeClaims?: boolean;
    retrievalIndex?: RetrievalIndex;
    agentTrigger?: AgentTrigger;
    putIngested?: CommunicationsRepo['putIngested'];
  } = {},
) {
  const dedupeRepo: DedupeRepo = {
    claim: vi.fn().mockResolvedValue(overrides.dedupeClaims ?? true),
  };

  const putIngested: CommunicationsRepo['putIngested'] =
    overrides.putIngested ??
    vi.fn(async (message): Promise<ApiCommunicationRecord> => ({
      ...message,
      commId: `${message.channelType}#${message.externalId}`,
      status: 'ingested',
      ingestedAt: new Date().toISOString(),
    }));

  const communicationsRepo: Pick<CommunicationsRepo, 'putIngested'> = { putIngested };

  const retrievalIndex: RetrievalIndex =
    overrides.retrievalIndex ??
    ({
      indexChunks: vi.fn().mockResolvedValue(undefined),
      search: vi.fn(),
      filterSearch: vi.fn(),
    } as unknown as RetrievalIndex);

  const agentTrigger: AgentTrigger = overrides.agentTrigger ?? {
    publish: vi.fn().mockResolvedValue(undefined),
  };

  const metricsClient = { addMetric: vi.fn(), addDimension: vi.fn() };

  return {
    authToken: AUTH_TOKEN,
    webhookUrl: WEBHOOK_URL,
    dedupeRepo,
    communicationsRepo: communicationsRepo as CommunicationsRepo,
    retrievalIndex,
    agentTrigger,
    log: noopLog,
    metricsClient,
  };
}

describe('isValidTwilioRequest', () => {
  it('accepts a validly signed request', () => {
    const payload = twilioPayload();
    const signature = signParams(AUTH_TOKEN, WEBHOOK_URL, payload);

    expect(
      isValidTwilioRequest({
        authToken: AUTH_TOKEN,
        url: WEBHOOK_URL,
        formParams: payload,
        signatureHeader: signature,
      }),
    ).toBe(true);
  });

  it('rejects a forged signature', () => {
    expect(
      isValidTwilioRequest({
        authToken: AUTH_TOKEN,
        url: WEBHOOK_URL,
        formParams: twilioPayload(),
        signatureHeader: 'forged==',
      }),
    ).toBe(false);
  });
});

describe('processInboundWhatsAppWebhook', () => {
  it('rejects an inbound delivery with a missing/invalid signature without persisting anything', async () => {
    const deps = makeDeps();

    const result = await processInboundWhatsAppWebhook(twilioPayload(), 'forged==', deps);

    expect(result).toEqual({ outcome: 'unauthorized' });
    expect(deps.dedupeRepo.claim).not.toHaveBeenCalled();
    expect(deps.communicationsRepo.putIngested).not.toHaveBeenCalled();
    expect(deps.metricsClient.addMetric).toHaveBeenCalledWith(
      'WhatsAppSignatureRejected',
      'Count',
      1,
    );
  });

  it('normalizes, dedupes, and persists a validly signed inbound message', async () => {
    const deps = makeDeps();
    const payload = twilioPayload();
    const signature = signParams(AUTH_TOKEN, WEBHOOK_URL, payload);

    const result = await processInboundWhatsAppWebhook(payload, signature, deps);

    expect(result).toEqual({
      outcome: 'ingested',
      commId: 'whatsapp#SM1234567890abcdef1234567890abcdef',
    });
    expect(deps.dedupeRepo.claim).toHaveBeenCalledWith(
      'whatsapp#SM1234567890abcdef1234567890abcdef',
    );
    expect(deps.communicationsRepo.putIngested).toHaveBeenCalledTimes(1);
    const call = (deps.communicationsRepo.putIngested as ReturnType<typeof vi.fn>).mock.calls[0];
    const persisted = call?.[0];
    expect(persisted.accountId).toBe(WHATSAPP_DEMO_ACCOUNT_ID);
    expect(persisted.channelType).toBe('whatsapp');
    expect(deps.metricsClient.addMetric).toHaveBeenCalledWith('WhatsAppIngested', 'Count', 1);
  });

  it('skips persistence on a duplicate delivery (dedupe claim lost)', async () => {
    const deps = makeDeps({ dedupeClaims: false });
    const payload = twilioPayload();
    const signature = signParams(AUTH_TOKEN, WEBHOOK_URL, payload);

    const result = await processInboundWhatsAppWebhook(payload, signature, deps);

    expect(result.outcome).toBe('duplicate');
    expect(deps.communicationsRepo.putIngested).not.toHaveBeenCalled();
  });

  it('is idempotent: replaying the exact same signed delivery twice only persists once', async () => {
    const deps = makeDeps();
    const payload = twilioPayload();
    const signature = signParams(AUTH_TOKEN, WEBHOOK_URL, payload);

    // First call wins the dedupe claim (real DedupeRepo semantics simulated by flipping the mock).
    const claimMock = deps.dedupeRepo.claim as ReturnType<typeof vi.fn>;
    claimMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const first = await processInboundWhatsAppWebhook(payload, signature, deps);
    const second = await processInboundWhatsAppWebhook(payload, signature, deps);

    expect(first.outcome).toBe('ingested');
    expect(second.outcome).toBe('duplicate');
    expect(deps.communicationsRepo.putIngested).toHaveBeenCalledTimes(1);
  });

  it('still reports ingested when chunk indexing fails (isolated failure)', async () => {
    const failingIndex: RetrievalIndex = {
      indexChunks: vi.fn().mockRejectedValue(new Error('OpenSearch unavailable')),
      search: vi.fn(),
      filterSearch: vi.fn(),
    } as unknown as RetrievalIndex;
    const deps = makeDeps({ retrievalIndex: failingIndex });
    const payload = twilioPayload();
    const signature = signParams(AUTH_TOKEN, WEBHOOK_URL, payload);

    const result = await processInboundWhatsAppWebhook(payload, signature, deps);

    expect(result.outcome).toBe('ingested');
    expect(deps.metricsClient.addMetric).toHaveBeenCalledWith('ChunkIndexFailed', 'Count', 1);
  });

  it('still reports ingested when the agent-trigger publish fails (isolated failure)', async () => {
    const failingTrigger: AgentTrigger = {
      publish: vi.fn().mockRejectedValue(new Error('AGENT_QUEUE_URL not set')),
    };
    const deps = makeDeps({ agentTrigger: failingTrigger });
    const payload = twilioPayload();
    const signature = signParams(AUTH_TOKEN, WEBHOOK_URL, payload);

    const result = await processInboundWhatsAppWebhook(payload, signature, deps);

    expect(result.outcome).toBe('ingested');
    expect(deps.metricsClient.addMetric).toHaveBeenCalledWith('AgentTriggerFailed', 'Count', 1);
  });

  it('never logs message body or phone numbers on the happy path', async () => {
    const deps = makeDeps();
    const payload = twilioPayload();
    const signature = signParams(AUTH_TOKEN, WEBHOOK_URL, payload);

    await processInboundWhatsAppWebhook(payload, signature, deps);

    const allLogCalls = [
      ...(deps.log.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(deps.log.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(deps.log.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    const serialized = JSON.stringify(allLogCalls);
    expect(serialized).not.toContain('Thursday sync');
    expect(serialized).not.toContain('+15551234567');
  });

  it('returns failed (not thrown) when normalization itself throws', async () => {
    const deps = makeDeps();
    const payload = twilioPayload();
    delete payload.MessageSid; // malformed — normalize.ts throws
    const signature = signParams(AUTH_TOKEN, WEBHOOK_URL, payload);

    const result = await processInboundWhatsAppWebhook(payload, signature, deps);

    expect(result.outcome).toBe('failed');
    expect(deps.metricsClient.addMetric).toHaveBeenCalledWith('WhatsAppIngestFailed', 'Count', 1);
  });
});
