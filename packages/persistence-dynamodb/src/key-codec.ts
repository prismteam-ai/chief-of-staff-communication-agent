import { createHmac } from 'node:crypto';
import {
  keyedDigestValueSchema,
  type KeyedDigestValue,
} from '@chief/contracts/ids';

export type SensitiveIdentifierKind =
  'email' | 'phone' | 'handle' | 'provider_subject' | 'opaque';
export type DigestPurpose =
  'identity' | 'dedupe' | 'correlation' | 'feedback' | 'uniqueness';

export interface DigestKeyMaterial {
  readonly version: string;
  readonly secret: Uint8Array;
}

export interface KeyCodecOptions {
  readonly current: DigestKeyMaterial;
  readonly previous?: readonly DigestKeyMaterial[];
}

export interface SensitiveDigestInput {
  readonly tenantId: string;
  readonly purpose: DigestPurpose;
  readonly kind: SensitiveIdentifierKind;
  readonly value: string;
}

const INTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;

function requireInternalId(value: string): string {
  if (!INTERNAL_ID.test(value)) throw new Error('Invalid internal identifier.');
  return Buffer.from(value, 'utf8').toString('base64url');
}

function normalizeSensitive(
  kind: SensitiveIdentifierKind,
  value: string,
): string {
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length === 0 || normalized.length > 2_048)
    throw new Error('Invalid sensitive identifier.');
  switch (kind) {
    case 'email':
      return normalized.toLocaleLowerCase('en-US');
    case 'phone': {
      const digits = normalized.replace(/[^0-9]/gu, '');
      if (!/^[1-9][0-9]{7,14}$/u.test(digits))
        throw new Error('Invalid sensitive identifier.');
      return `+${digits}`;
    }
    case 'handle':
      return normalized.replace(/^@/u, '').toLocaleLowerCase('en-US');
    case 'provider_subject':
    case 'opaque':
      return normalized;
  }
}

function validateMaterial(material: DigestKeyMaterial): void {
  if (!KEY_VERSION.test(material.version) || material.secret.byteLength < 32) {
    throw new Error('Invalid digest key material.');
  }
}

export class KeyCodec {
  readonly #current: DigestKeyMaterial;
  readonly #all: readonly DigestKeyMaterial[];

  public constructor(options: KeyCodecOptions) {
    const all = [options.current, ...(options.previous ?? [])];
    all.forEach(validateMaterial);
    if (new Set(all.map(({ version }) => version)).size !== all.length)
      throw new Error('Duplicate digest key version.');
    this.#current = options.current;
    this.#all = Object.freeze([...all]);
  }

  public coreEntity(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Readonly<{ PK: string; SK: string }> {
    return Object.freeze({
      PK: `T#${requireInternalId(tenantId)}`,
      SK: `E#${requireInternalId(entityType)}#${requireInternalId(entityId)}`,
    });
  }

  public coreRevision(
    tenantId: string,
    entityType: string,
    entityId: string,
    version: number,
    revisionId: string,
  ): Readonly<{ PK: string; SK: string }> {
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error('Invalid revision version.');
    const head = this.coreEntity(tenantId, entityType, entityId);
    return Object.freeze({
      PK: head.PK,
      SK: `${head.SK}#REV#${version.toString().padStart(12, '0')}#${requireInternalId(revisionId)}`,
    });
  }

  public connectorEntity(
    tenantId: string,
    accountId: string,
    stateType: string,
    stateId: string,
  ): Readonly<{ PK: string; SK: string }> {
    return Object.freeze({
      PK: `T#${requireInternalId(tenantId)}#A#${requireInternalId(accountId)}`,
      SK: `S#${requireInternalId(stateType)}#${requireInternalId(stateId)}`,
    });
  }

  public retrievalEntity(
    tenantId: string,
    scopeId: string,
    role: 'factual' | 'style',
    entityId: string,
  ): Readonly<{ PK: string; SK: string }> {
    return Object.freeze({
      PK: `T#${requireInternalId(tenantId)}#R#${requireInternalId(role)}#S#${requireInternalId(scopeId)}`,
      SK: `I#${requireInternalId(entityId)}`,
    });
  }

  public digest(input: SensitiveDigestInput): KeyedDigestValue {
    return this.#digestWith(input, this.#current);
  }

  public digestCandidates(
    input: SensitiveDigestInput,
  ): readonly KeyedDigestValue[] {
    return Object.freeze(
      this.#all.map((material) => this.#digestWith(input, material)),
    );
  }

  #digestWith(
    input: SensitiveDigestInput,
    material: DigestKeyMaterial,
  ): KeyedDigestValue {
    const tenant = requireInternalId(input.tenantId);
    const normalized = normalizeSensitive(input.kind, input.value);
    const message = [
      'chief-sensitive-key',
      '1',
      tenant,
      input.purpose,
      input.kind,
      normalized,
    ].join('\u0000');
    const digest = createHmac('sha256', material.secret)
      .update(message, 'utf8')
      .digest('base64url');
    return keyedDigestValueSchema.parse(`h1_${material.version}_${digest}`);
  }
}
