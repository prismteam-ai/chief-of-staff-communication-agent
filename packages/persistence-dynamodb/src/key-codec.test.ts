import { describe, expect, it } from 'vitest';
import { keyedDigestValueSchema, sha256Schema } from '@chief/contracts/ids';
import { KeyCodec } from './key-codec.js';

const keyV2 = new Uint8Array(32).fill(2);
const keyV1 = new Uint8Array(32).fill(1);

function codec(): KeyCodec {
  return new KeyCodec({
    current: { version: 'v2', secret: keyV2 },
    previous: [{ version: 'v1', secret: keyV1 }],
  });
}

describe('KeyCodec', () => {
  it('isolates the same normalized identifier across tenants and purposes', () => {
    const keys = codec();
    const base = { kind: 'email' as const, value: '  EXEC@example.com ' };
    const identity = keys.digest({
      ...base,
      tenantId: 'tenant-a',
      purpose: 'identity',
    });
    expect(identity).toBe(
      keys.digest({
        ...base,
        value: 'exec@EXAMPLE.com',
        tenantId: 'tenant-a',
        purpose: 'identity',
      }),
    );
    expect(identity).not.toBe(
      keys.digest({ ...base, tenantId: 'tenant-b', purpose: 'identity' }),
    );
    expect(identity).not.toBe(
      keys.digest({ ...base, tenantId: 'tenant-a', purpose: 'dedupe' }),
    );
    expect(identity).not.toContain('exec');
    expect(identity).not.toContain('example');
  });

  it('normalizes equivalent phone/handle forms without crossing identifier domains', () => {
    const keys = codec();
    const phoneA = keys.digest({
      tenantId: 'tenant-a',
      purpose: 'identity',
      kind: 'phone',
      value: '+1 (202) 555-0198',
    });
    const phoneB = keys.digest({
      tenantId: 'tenant-a',
      purpose: 'identity',
      kind: 'phone',
      value: '12025550198',
    });
    const handle = keys.digest({
      tenantId: 'tenant-a',
      purpose: 'identity',
      kind: 'handle',
      value: '@12025550198',
    });
    expect(phoneA).toBe(phoneB);
    expect(phoneA).not.toBe(handle);
  });

  it('supports explicit dual-read key rotation while writing the current version', () => {
    const keys = codec();
    const input = {
      tenantId: 'tenant-a',
      purpose: 'correlation' as const,
      kind: 'provider_subject' as const,
      value: 'provider-value',
    };
    expect(keys.digest(input)).toMatch(/^h1_v2_/u);
    expect(
      keys.digestCandidates(input).map((value) => value.slice(0, 6)),
    ).toEqual(['h1_v2_', 'h1_v1_']);
  });

  it('emits canonical contract keyed digests distinct from content hashes', () => {
    const output = codec().digest({
      tenantId: 'tenant-a',
      purpose: 'correlation',
      kind: 'provider_subject',
      value: 'provider-value',
    });
    expect(keyedDigestValueSchema.safeParse(output).success).toBe(true);
    expect(keyedDigestValueSchema.safeParse('a'.repeat(64)).success).toBe(
      false,
    );
    expect(sha256Schema.safeParse(output).success).toBe(false);
    expect(sha256Schema.safeParse('a'.repeat(64)).success).toBe(true);
  });

  it('uses tenant-explicit table keys without sensitive provider identifiers', () => {
    const keys = codec();
    const core = keys.coreEntity('tenant-a', 'message', 'internal-01');
    const connector = keys.connectorEntity(
      'tenant-a',
      'account-01',
      'checkpoint',
      'inbox',
    );
    const retrieval = keys.retrievalEntity(
      'tenant-a',
      'executive',
      'factual',
      'head',
    );
    expect(core.PK).toMatch(/^T#/u);
    expect(connector.PK).toContain('#A#');
    expect(retrieval.PK).toContain('#R#');
    expect(JSON.stringify({ core, connector, retrieval })).not.toContain(
      'provider-value',
    );
  });

  it('rejects invalid inputs without reflecting the raw identifier in errors', () => {
    const raw = 'secret-not-a-phone';
    expect(() =>
      codec().digest({
        tenantId: 'tenant-a',
        purpose: 'identity',
        kind: 'phone',
        value: raw,
      }),
    ).toThrow('Invalid sensitive identifier.');
    try {
      codec().digest({
        tenantId: 'tenant-a',
        purpose: 'identity',
        kind: 'phone',
        value: raw,
      });
    } catch (error) {
      expect(String(error)).not.toContain(raw);
    }
  });
});
