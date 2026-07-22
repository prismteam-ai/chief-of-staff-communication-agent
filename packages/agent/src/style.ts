import {
  timestampSchema,
  type TenantId,
  type UserId,
} from '@chief/contracts/ids';

import { immutableHash } from './canonical.js';

export type CommunicationChannel =
  'email' | 'sms' | 'whatsapp' | 'x' | 'linkedin' | 'generic';

export interface ApprovedStyleExample {
  readonly exampleId: string;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly brandId: string;
  readonly channel: CommunicationChannel;
  readonly body: string;
  readonly approvedAt: string;
  readonly approved: true;
}

export interface StyleProfile {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly brandId: string;
  readonly channel: CommunicationChannel;
  readonly exampleIds: readonly string[];
  readonly exampleCount: number;
  readonly tone: 'formal' | 'conversational' | 'neutral';
  readonly brevity: 'concise' | 'balanced' | 'detailed';
  readonly greeting: 'hi' | 'hello' | 'hey' | 'dear' | 'none';
  readonly signoff: 'thanks' | 'best' | 'regards' | 'none';
  readonly emojiAllowed: boolean;
  readonly maximumCharacters: number;
  readonly version: string;
  readonly profileHash: string;
}

const channelLimits: Record<CommunicationChannel, number> = {
  email: 4_000,
  sms: 320,
  whatsapp: 1_000,
  x: 280,
  linkedin: 1_000,
  generic: 1_000,
};

function firstLine(body: string): string {
  return body.trim().split(/\r?\n/u)[0]?.trim().toLowerCase() ?? '';
}

function lastLine(body: string): string {
  return body.trim().split(/\r?\n/u).at(-1)?.trim().toLowerCase() ?? '';
}

function chooseMostCommon<T extends string>(
  values: readonly T[],
  fallback: T,
): T {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return (
    [...counts].sort(
      ([leftValue, leftCount], [rightValue, rightCount]) =>
        rightCount - leftCount || leftValue.localeCompare(rightValue),
    )[0]?.[0] ?? fallback
  );
}

function greeting(body: string): StyleProfile['greeting'] {
  const line = firstLine(body);
  if (/^dear\b/u.test(line)) return 'dear';
  if (/^hello\b/u.test(line)) return 'hello';
  if (/^hey\b/u.test(line)) return 'hey';
  if (/^hi\b/u.test(line)) return 'hi';
  return 'none';
}

function signoff(body: string): StyleProfile['signoff'] {
  const line = lastLine(body);
  if (/^regards[,!]?(?:\s|$)/u.test(line)) return 'regards';
  if (/^best[,!]?(?:\s|$)/u.test(line)) return 'best';
  if (/^thanks[,!]?(?:\s|$)/u.test(line)) return 'thanks';
  return 'none';
}

export function learnStyleProfile(input: {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly brandId: string;
  readonly channel: CommunicationChannel;
  readonly examples: readonly ApprovedStyleExample[];
}): StyleProfile {
  const examples = input.examples
    .filter(({ channel }) => channel === input.channel)
    .sort((left, right) => left.exampleId.localeCompare(right.exampleId));
  for (const example of examples) {
    if (
      example.tenantId !== input.tenantId ||
      example.userId !== input.userId ||
      example.brandId !== input.brandId
    )
      throw new Error('STYLE_SCOPE_MISMATCH');
    if (
      !example.exampleId.trim() ||
      !example.body.trim() ||
      !timestampSchema.safeParse(example.approvedAt).success
    )
      throw new Error('INVALID_STYLE_EXAMPLE');
  }
  const averageWords =
    examples.length === 0
      ? 0
      : examples.reduce(
          (sum, { body }) =>
            sum + body.trim().split(/\s+/u).filter(Boolean).length,
          0,
        ) / examples.length;
  const formalCount = examples.filter(({ body }) =>
    /\b(dear|regards|please|kindly)\b/iu.test(body),
  ).length;
  const conversationalCount = examples.filter(({ body }) =>
    /\b(hi|hey|thanks|i'll|we'll)\b/iu.test(body),
  ).length;
  const dimensions = {
    tenantId: input.tenantId,
    userId: input.userId,
    brandId: input.brandId,
    channel: input.channel,
    exampleIds: examples.map(({ exampleId }) => exampleId),
    exampleCount: examples.length,
    tone:
      examples.length === 0
        ? ('neutral' as const)
        : formalCount > conversationalCount
          ? ('formal' as const)
          : ('conversational' as const),
    brevity:
      examples.length === 0 || averageWords < 45
        ? ('concise' as const)
        : averageWords > 120
          ? ('detailed' as const)
          : ('balanced' as const),
    greeting: chooseMostCommon(
      examples.map(({ body }) => greeting(body)),
      input.channel === 'email' ? ('hi' as const) : ('none' as const),
    ),
    signoff: chooseMostCommon(
      examples.map(({ body }) => signoff(body)),
      input.channel === 'email' ? ('thanks' as const) : ('none' as const),
    ),
    emojiAllowed: examples.some(({ body }) =>
      /\p{Extended_Pictographic}/u.test(body),
    ),
    maximumCharacters: channelLimits[input.channel],
  };
  const profileHash = immutableHash(dimensions);
  return Object.freeze({
    ...dimensions,
    exampleIds: Object.freeze(dimensions.exampleIds),
    version: `style-${profileHash.slice(0, 12)}`,
    profileHash,
  });
}
