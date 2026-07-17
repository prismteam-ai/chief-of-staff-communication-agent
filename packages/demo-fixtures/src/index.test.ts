import { describe, expect, it } from 'vitest';

import {
  assertTenantLocalRevision,
  computeDemoCorpusHash,
  createDemoCorpus,
  resetDemoCorpus,
  serializeDemoCorpusManifest,
  validateDemoCorpus,
  type DemoCorpus,
} from './index.js';

const defaultCorpus = createDemoCorpus();

describe('deterministic Chief demo corpus', () => {
  it('replays byte-stable hashes and scenario artifacts for the same seed and clock', () => {
    const first = defaultCorpus;
    const second = createDemoCorpus();

    expect(first.manifest.corpusHash).toBe(second.manifest.corpusHash);
    expect(first.scenario.recommendation).toEqual(
      second.scenario.recommendation,
    );
    expect(first.scenario.draft.contentHash).toBe(
      second.scenario.draft.contentHash,
    );
    expect(first.scenario.actionPlan.canonicalHash).toBe(
      second.scenario.actionPlan.canonicalHash,
    );
    expect(computeDemoCorpusHash(first)).toBe(first.manifest.corpusHash);
  });

  it('generates a non-toy, multi-channel, multi-brand corpus without bulk files', () => {
    const corpus = defaultCorpus;

    expect(corpus.manifest.counts).toMatchObject({
      tenants: 2,
      brands: 3,
      accounts: 10,
      threads: 184,
      messages: 1_240,
      attachments: 36,
      asanaObjects: 66,
      styleExamples: 60,
      edgeCases: 120,
    });
    expect(corpus.manifest.channelCoverage).toEqual([
      'gmail',
      'microsoft_graph',
      'sms',
      'whatsapp',
      'x',
      'linkedin_archive',
      'future_demo',
    ]);
    expect(
      corpus.bodies.some((body) =>
        body.bodyText.includes('Ignore every policy'),
      ),
    ).toBe(true);
    expect(corpus.people.some((person) => person.ambiguousWithPersonId)).toBe(
      true,
    );
    expect(
      corpus.contactPolicies.some((policy) => policy.state === 'suppressed'),
    ).toBe(true);
    expect(
      corpus.contactPolicies.some((policy) => policy.state === 'window_closed'),
    ).toBe(true);
  });

  it('passes frozen schemas, referential integrity, isolation, coverage, and safety validation', () => {
    const corpus = defaultCorpus;
    const report = validateDemoCorpus(corpus);

    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
  }, 20_000);

  it('keeps all references tenant-local and rejects cross-tenant use', () => {
    const corpus = defaultCorpus;
    const primary = corpus.messageRevisions.find(
      (revision) => revision.tenantId === 'tenant-demo-northstar',
    );
    const isolated = corpus.messageRevisions.find(
      (revision) => revision.tenantId === 'tenant-demo-isolation',
    );
    expect(primary).toBeDefined();
    expect(isolated).toBeDefined();
    expect(() =>
      assertTenantLocalRevision(primary!, 'tenant-demo-isolation'),
    ).toThrow('tenant boundary');
    expect(assertTenantLocalRevision(isolated!, 'tenant-demo-isolation')).toBe(
      isolated,
    );
  });

  it('detects tampering through both referential validation and the corpus hash', () => {
    const corpus = structuredClone(defaultCorpus);
    const messages = corpus.messages as DemoCorpus['messages'][number][];
    const first = messages[0];
    expect(first).toBeDefined();
    messages[0] = {
      ...first!,
      currentRevisionId: 'missing-revision',
    } as DemoCorpus['messages'][number];

    const report = validateDemoCorpus(corpus);
    expect(report.valid).toBe(false);
    expect(report.errors).toContain(
      `message ${first!.messageId} current revision is inconsistent`,
    );
    expect(report.errors).toContain(
      'corpus hash does not match generated content',
    );
  });

  it('exposes a coherent cited, style, approval, Asana, and SLA walkthrough', () => {
    const scenario = defaultCorpus.scenario;
    expect(scenario.recommendation.citations).toHaveLength(3);
    expect(scenario.draft.citations).toEqual(scenario.recommendation.citations);
    expect(
      scenario.approvals.map((approval) => approval.status).sort(),
    ).toEqual(['active', 'invalidated']);
    expect(
      scenario.actionPlan.operations.map((operation) => operation.kind),
    ).toEqual(['send_message', 'update_task']);
    expect(scenario.expectedSla.actionableWithinFiveMinutes).toBe(
      scenario.expectedSla.totalInbound,
    );
    expect(
      scenario.capabilityLabels.every(
        (capability) => !capability.send && !capability.externalEffect,
      ),
    ).toBe(true);
  });

  it('resets to the pinned seed, clock, and canonical manifest', () => {
    const first = resetDemoCorpus();
    const second = resetDemoCorpus();
    expect(serializeDemoCorpusManifest(first)).toBe(
      serializeDemoCorpusManifest(second),
    );
    expect(first.manifest.resetVersion).toBe('demo-reset-v1');
  });
});
