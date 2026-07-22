import { createHash } from 'node:crypto';

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function decodeBase64Json<T>(rawBodyBase64: string): T {
  const text = Buffer.from(rawBodyBase64, 'base64').toString('utf8');
  return JSON.parse(text) as T;
}
