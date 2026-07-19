import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  asanaAcceptanceEvidenceDocumentPath,
  asanaAcceptanceEvidenceMarkdown,
  asanaAcceptanceEvidenceSha256,
  createAsanaAcceptanceEvidenceResult,
} from './asana-acceptance-evidence.js';

const committedDocumentUrl = new URL(
  `../../../${asanaAcceptanceEvidenceDocumentPath}`,
  import.meta.url,
);

async function readCommittedDocument(): Promise<string> {
  const raw = await readFile(committedDocumentUrl, 'utf8');
  return raw.replaceAll('\r\n', '\n');
}

describe('asana acceptance evidence module', () => {
  it('matches the committed evidence document exactly', async () => {
    const committed = await readCommittedDocument();

    expect(asanaAcceptanceEvidenceMarkdown).toBe(committed);
    expect(asanaAcceptanceEvidenceSha256).toBe(
      createHash('sha256').update(committed, 'utf8').digest('hex'),
    );
  });

  it('serves the exact committed bytes and hash through the result builder', async () => {
    const committed = await readCommittedDocument();
    const result = createAsanaAcceptanceEvidenceResult();

    expect(result).toEqual({
      documentPath: asanaAcceptanceEvidenceDocumentPath,
      contentType: 'text/markdown',
      sha256: createHash('sha256').update(committed, 'utf8').digest('hex'),
      markdown: committed,
    });
  });

  it('contains no credential-shaped values', () => {
    expect(asanaAcceptanceEvidenceMarkdown).not.toMatch(
      /Bearer |password|secret|token=/iu,
    );
    expect(asanaAcceptanceEvidenceMarkdown).toContain('emits no credential');
  });
});
