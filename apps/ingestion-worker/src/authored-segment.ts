import { createHash } from 'node:crypto';

import { authoredSegmentSchema, type MessageRevision } from '@chief/contracts';

import type { AuthoredSegmentResult } from './types.js';

const QUOTE_MARKERS: readonly {
  readonly expression: RegExp;
  readonly locale?: string;
}[] = [
  { expression: /^On .+wrote:\s*$/imu, locale: 'en' },
  { expression: /^El .+escribi[oó]:\s*$/imu, locale: 'es' },
  { expression: /^Le .+a écrit\s*:\s*$/imu, locale: 'fr' },
  { expression: /^Am .+schrieb .+:\s*$/imu, locale: 'de' },
  { expression: /^-{2,}\s*Original Message\s*-{2,}\s*$/imu, locale: 'en' },
  { expression: /^From:\s+.+$/imu, locale: 'en' },
  { expression: /^>\s?/mu },
];

const FORWARD_MARKER = /^-{2,}\s*Forwarded message\s*-{2,}\s*$/imu;
const SIGNATURE_MARKER = /^(?:--\s*$|Sent from my .+$)/imu;

function firstMatch(
  body: string,
  expression: RegExp,
): RegExpExecArray | undefined {
  expression.lastIndex = 0;
  return expression.exec(body) ?? undefined;
}

export function extractAuthoredSegment(body: string): AuthoredSegmentResult {
  const markers = QUOTE_MARKERS.flatMap((marker) => {
    const match = firstMatch(body, marker.expression);
    return match === undefined ? [] : [{ ...marker, match }];
  }).sort((left, right) => left.match.index - right.match.index);
  const forward = firstMatch(body, FORWARD_MARKER);
  const signature = firstMatch(body, SIGNATURE_MARKER);
  const boundaries: AuthoredSegmentResult['boundaries'][number][] = [];
  const localeMarkers = [
    ...new Set(markers.flatMap((marker) => marker.locale ?? [])),
  ];
  const ambiguityReasons: string[] = [];

  const quoteStart = markers[0]?.match.index;
  const forwardStart = forward?.index;
  const historyStart = [quoteStart, forwardStart]
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right)[0];

  if (historyStart === undefined) {
    if (
      /\b(?:ignore previous|system prompt|developer message)\b/iu.test(body) &&
      /\n\s*>?/u.test(body)
    ) {
      ambiguityReasons.push(
        'instruction_like_text_without_reliable_quote_boundary',
      );
    }
    const signatureStart = signature?.index;
    if (signatureStart !== undefined && signatureStart > 0) {
      boundaries.push({ kind: 'authored', start: 0, end: signatureStart });
      boundaries.push({
        kind: 'signature',
        start: signatureStart,
        end: body.length,
      });
      return {
        authoredText: body.slice(0, signatureStart).trimEnd(),
        boundaries,
        confidence: 0.86,
        ambiguityReasons,
        localeMarkers,
      };
    }
    return {
      authoredText: body,
      boundaries: [{ kind: 'authored', start: 0, end: body.length }],
      confidence: ambiguityReasons.length === 0 ? 0.92 : 0.35,
      ambiguityReasons,
      localeMarkers,
    };
  }

  if (historyStart === 0 || body.slice(0, historyStart).trim().length === 0) {
    ambiguityReasons.push('history_boundary_precedes_authored_content');
    return {
      authoredText: body,
      boundaries: [
        {
          kind: forwardStart === 0 ? 'forward' : 'quote',
          start: 0,
          end: body.length,
        },
      ],
      confidence: 0.25,
      ambiguityReasons,
      localeMarkers,
    };
  }

  const authoredEnd =
    signature !== undefined && signature.index < historyStart
      ? signature.index
      : historyStart;
  boundaries.push({ kind: 'authored', start: 0, end: authoredEnd });
  if (signature !== undefined && signature.index < historyStart) {
    boundaries.push({
      kind: 'signature',
      start: signature.index,
      end: historyStart,
    });
  }
  boundaries.push({
    kind: forwardStart === historyStart ? 'forward' : 'quote',
    start: historyStart,
    end: body.length,
  });
  return {
    authoredText: body.slice(0, authoredEnd).trimEnd(),
    boundaries,
    confidence:
      markers.length > 1 && markers[1]?.match.index === historyStart
        ? 0.65
        : 0.9,
    ambiguityReasons,
    localeMarkers,
  };
}

export function toAuthoredSegment(
  body: string,
  derivedAt: string,
): MessageRevision['currentAuthoredSegment'] {
  const result = extractAuthoredSegment(body);
  return authoredSegmentSchema.parse({
    parserVersion: 'authored-v1',
    inputBodyHash: createHash('sha256').update(body).digest('hex'),
    authoredText: result.authoredText,
    boundaries: result.boundaries,
    confidence: result.confidence,
    ambiguityReasons: result.ambiguityReasons,
    localeMarkers: result.localeMarkers,
    derivedAt,
  });
}
