import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function fixtureDigest(value: string): string {
  const encoded = createHash('sha256')
    .update(`demo:${value}`)
    .digest('base64url');
  return `h1_demo_v1_${encoded}`;
}

export function isoAt(baseTimestamp: string, offsetMs: number): string {
  return new Date(Date.parse(baseTimestamp) + offsetMs).toISOString();
}

export function padded(value: number, width = 4): string {
  return value.toString().padStart(width, '0');
}

export function seededIndex(
  seed: number,
  index: number,
  modulus: number,
): number {
  if (modulus <= 0) {
    throw new Error('modulus must be positive');
  }
  const mixed = Math.imul(seed ^ (index + 1), 2_654_435_761) >>> 0;
  return mixed % modulus;
}
