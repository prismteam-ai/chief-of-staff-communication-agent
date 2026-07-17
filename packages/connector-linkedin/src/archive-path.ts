import { normalize } from 'node:path/posix';

import { LinkedinArchiveImportError } from './errors.js';

const CONFUSABLE_SEPARATORS = /[\u2215\u2044\uff0f]/u;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

export function normalizeArchivePath(candidate: string): string {
  const unicodeNormalized = candidate.normalize('NFC');
  if (
    unicodeNormalized.length === 0 ||
    unicodeNormalized.startsWith('/') ||
    unicodeNormalized.startsWith('\\') ||
    unicodeNormalized.includes('\\') ||
    unicodeNormalized.includes(':') ||
    unicodeNormalized.includes('%') ||
    containsControlCharacter(unicodeNormalized) ||
    CONFUSABLE_SEPARATORS.test(unicodeNormalized)
  ) {
    throw new LinkedinArchiveImportError('UNSAFE_ARCHIVE_PATH');
  }

  const segments = unicodeNormalized.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.endsWith(' ') ||
        segment.endsWith('.'),
    )
  ) {
    throw new LinkedinArchiveImportError('UNSAFE_ARCHIVE_PATH');
  }

  const normalized = normalize(unicodeNormalized);
  if (normalized !== unicodeNormalized || normalized.startsWith('../')) {
    throw new LinkedinArchiveImportError('UNSAFE_ARCHIVE_PATH');
  }
  return normalized;
}
