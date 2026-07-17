import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { RawWebhookRequest } from '@chief/contracts/connectors';

import { sha256 } from './canonical.js';
import type {
  AsanaCompactEvent,
  AsanaObjectKind,
  AsanaWebhookBatch,
  AsanaWebhookEvent,
} from './types.js';

export type AsanaWebhookIngress =
  | Readonly<{
      kind: 'handshake';
      responseHeaders: { 'x-hook-secret': string };
    }>
  | Readonly<{
      kind: 'verified_events';
      events: readonly AsanaCompactEvent[];
      heartbeatAt?: string;
      rawPayloadDigest: string;
    }>
  | Readonly<{ kind: 'rejected'; reasonCode: string }>;

function header(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1];
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function objectKind(event: AsanaWebhookEvent): AsanaObjectKind | undefined {
  if (
    event.resource.resource_type === 'task' &&
    event.resource.resource_subtype === 'milestone'
  ) {
    return 'milestone';
  }
  if (event.resource.resource_type === 'task') return 'task';
  if (event.resource.resource_type === 'project') return 'project';
  if (event.resource.resource_type === 'story') return 'comment';
  return undefined;
}

function parseBatch(raw: Buffer): AsanaWebhookBatch | undefined {
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { events?: unknown }).events)
    ) {
      return undefined;
    }
    const events = (parsed as { events: unknown[] }).events;
    if (
      !events.every((event) => {
        if (event === null || typeof event !== 'object') return false;
        const item = event as Record<string, unknown>;
        const resource = item.resource;
        return (
          ['added', 'changed', 'deleted', 'removed', 'undeleted'].includes(
            String(item.action),
          ) &&
          typeof item.created_at === 'string' &&
          resource !== null &&
          typeof resource === 'object' &&
          typeof (resource as Record<string, unknown>).gid === 'string' &&
          typeof (resource as Record<string, unknown>).resource_type ===
            'string'
        );
      })
    ) {
      return undefined;
    }
    return { events: events as unknown as AsanaWebhookEvent[] };
  } catch {
    return undefined;
  }
}

export function verifyAsanaWebhook(
  request: RawWebhookRequest,
  secret: string,
): AsanaWebhookIngress {
  const challenge = header(request.headers, 'x-hook-secret');
  if (challenge !== undefined) {
    if (request.method !== 'POST' || challenge.length === 0) {
      return { kind: 'rejected', reasonCode: 'invalid_handshake' };
    }
    return {
      kind: 'handshake',
      responseHeaders: { 'x-hook-secret': challenge },
    };
  }

  const signature = header(request.headers, 'x-hook-signature');
  if (request.method !== 'POST' || signature === undefined) {
    return { kind: 'rejected', reasonCode: 'signature_missing' };
  }
  const raw = Buffer.from(request.rawBodyBase64, 'base64');
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  if (!secureEqual(signature.toLowerCase(), expected)) {
    return { kind: 'rejected', reasonCode: 'signature_invalid' };
  }
  const batch = parseBatch(raw);
  if (batch === undefined) {
    return { kind: 'rejected', reasonCode: 'payload_invalid' };
  }
  const compact = batch.events.flatMap((event) => {
    const kind = objectKind(event);
    if (kind === undefined) return [];
    return [
      {
        eventId: sha256({
          action: event.action,
          createdAt: event.created_at,
          gid: event.resource.gid,
          parent: event.parent?.gid,
        }),
        action: event.action,
        kind,
        gid: event.resource.gid,
        createdAt: event.created_at,
      } satisfies AsanaCompactEvent,
    ];
  });
  return {
    kind: 'verified_events',
    events: compact,
    ...(batch.events.length === 0 ? { heartbeatAt: request.receivedAt } : {}),
    rawPayloadDigest: createHashForBytes(raw),
  };
}

function createHashForBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
