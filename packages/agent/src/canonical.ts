import { createHash } from 'node:crypto';

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

export function immutableHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function deterministicId(prefix: string, value: unknown): string {
  return `${prefix}_${immutableHash(value).slice(0, 32)}`;
}
