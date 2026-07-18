import {
  deterministicEvaluatorIdentityV1,
  deterministicEvaluatorIdentityV2,
} from '@chief/contracts';
import { canonicalJson } from '@chief/rag';
import { describe, expect, it } from 'vitest';

import {
  buildHostedEvaluatorCorpusV2,
  hostedEvaluatorBrandCountsV2,
  hostedEvaluatorChannelCountsV2,
} from './hosted-corpus.js';

describe('hosted evaluator corpus V2', () => {
  it('replays the exact primary multi-channel corpus without isolation data', () => {
    const first = buildHostedEvaluatorCorpusV2();
    const second = buildHostedEvaluatorCorpusV2();

    expect(first).toMatchObject({
      messageCount: 1_120,
      threadCount: 160,
      accountCount: 7,
      brandCount: 2,
      channelCounts: hostedEvaluatorChannelCountsV2,
      brandCounts: hostedEvaluatorBrandCountsV2,
    });
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(new Set(first.workItems.map(({ accountId }) => accountId))).toEqual(
      new Set(deterministicEvaluatorIdentityV2.accountIds),
    );
    expect(
      new Set(first.workItems.flatMap(({ brandIds }) => brandIds ?? [])),
    ).toEqual(new Set(deterministicEvaluatorIdentityV2.brandIds));
    expect(JSON.stringify(first)).not.toContain('tenant-demo-isolation');
    expect(
      first.workItems.every(
        ({ tenantId, authorizationEpoch, scopeHash }) =>
          tenantId === deterministicEvaluatorIdentityV2.tenantId &&
          authorizationEpoch ===
            deterministicEvaluatorIdentityV2.authorizationEpoch &&
          scopeHash === deterministicEvaluatorIdentityV2.scopeHash,
      ),
    ).toBe(true);
  });

  it('overlays exactly two V1 anchors without changing their canonical inputs', () => {
    const corpus = buildHostedEvaluatorCorpusV2();
    const anchors = corpus.workItems.filter(
      ({ record }) =>
        record.kind === 'gmail' &&
        deterministicEvaluatorIdentityV2.anchorOverlays.some(
          ({ providerMessageId }) => providerMessageId === record.id,
        ),
    );

    expect(anchors).toHaveLength(2);
    expect(
      anchors.map(({ accountId, record }) => ({
        accountId,
        providerMessageId: record.kind === 'gmail' ? record.id : 'wrong',
        providerThreadId: record.kind === 'gmail' ? record.threadId : 'wrong',
      })),
    ).toEqual(
      deterministicEvaluatorIdentityV2.anchorOverlays.map((anchor) => ({
        accountId: deterministicEvaluatorIdentityV1.accountId,
        providerMessageId: anchor.providerMessageId,
        providerThreadId: anchor.providerThreadId,
      })),
    );
    expect(anchors.map(({ brandIds }) => brandIds)).toEqual([
      ['brand-northstar'],
      ['brand-northstar'],
    ]);
  });

  it('labels every generated record with its honest fixture/manual source shape', () => {
    const corpus = buildHostedEvaluatorCorpusV2();
    const sourceCounts = Object.fromEntries(
      [...new Set(corpus.workItems.map(({ source }) => source))].map(
        (source) => [
          source,
          corpus.workItems.filter((item) => item.source === source).length,
        ],
      ),
    );
    expect(sourceCounts).toEqual({
      gmail: 161,
      microsoft_graph: 161,
      twilio_sms: 161,
      twilio_whatsapp: 161,
      x: 161,
      linkedin_archive: 161,
      demo: 154,
    });
    expect(
      corpus.workItems.every(
        ({ connectorSnapshot }) =>
          connectorSnapshot.runtimeMode === 'fixture' ||
          connectorSnapshot.runtimeMode === 'manual',
      ),
    ).toBe(true);
  });
});
