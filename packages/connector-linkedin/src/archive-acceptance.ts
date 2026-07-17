import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import {
  importLinkedinArchive,
  LINKEDIN_ARCHIVE_IMPORT_DEFAULT_LIMITS,
} from './archive-import.js';
import type {
  LinkedinArchiveImportLimits,
  LinkedinArchiveZipLimits,
} from './archive-types.js';
import {
  LINKEDIN_ARCHIVE_ZIP_DEFAULT_LIMITS,
  readLinkedinArchiveZipEntries,
} from './archive-zip.js';

export interface LinkedinArchiveAcceptanceOptions {
  readonly tenantId: string;
  readonly accountId: string;
  readonly importedAt: string;
  readonly zipLimits?: LinkedinArchiveZipLimits;
  readonly importLimits?: LinkedinArchiveImportLimits;
}

export interface LinkedinArchiveAcceptanceReport {
  readonly schemaVersion: '1';
  readonly status: 'pass';
  readonly containerSha256: string;
  readonly logicalArchiveSha256: string;
  readonly counts: {
    readonly entries: number;
    readonly sourceBytes: number;
    readonly conversations: number;
    readonly participants: number;
    readonly messages: number;
    readonly attachments: number;
    readonly duplicateRows: number;
    readonly malformedRows: number;
  };
  readonly admission: {
    readonly admittedToRag: false;
    readonly status: string;
    readonly expectedBoundedProfileMaximum: number;
    readonly promotionEvaluationThreshold: number;
    readonly hardStopThreshold: number;
  };
  readonly enforcedDefaultLimits: {
    readonly zip: typeof LINKEDIN_ARCHIVE_ZIP_DEFAULT_LIMITS;
    readonly importer: typeof LINKEDIN_ARCHIVE_IMPORT_DEFAULT_LIMITS;
  };
}

async function hashFile(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath) as AsyncIterable<Buffer>)
    digest.update(chunk);
  return digest.digest('hex');
}

export async function acceptLinkedinArchiveZip(
  filePath: string,
  options: LinkedinArchiveAcceptanceOptions,
): Promise<LinkedinArchiveAcceptanceReport> {
  const result = await importLinkedinArchive(
    {
      tenantId: options.tenantId,
      accountId: options.accountId,
      importedAt: options.importedAt,
      provenance: {
        sourceKind: 'user_export',
        userProvided: true,
        exportLabel: 'Operator-authorized user export acceptance input',
      },
      entries: readLinkedinArchiveZipEntries(filePath, options.zipLimits),
    },
    options.importLimits,
  );
  return Object.freeze({
    schemaVersion: '1',
    status: 'pass',
    containerSha256: await hashFile(filePath),
    logicalArchiveSha256: result.provenance.archiveSha256,
    counts: Object.freeze({
      entries: result.provenance.sourceEntryCount,
      sourceBytes: result.provenance.sourceByteCount,
      conversations: result.conversations.length,
      participants: result.participants.length,
      messages: result.messages.length,
      attachments: result.attachments.length,
      duplicateRows: result.duplicateRowCount,
      malformedRows: result.malformedRowCount,
    }),
    admission: Object.freeze({
      admittedToRag: false,
      status: result.admission.status,
      expectedBoundedProfileMaximum:
        result.admission.expectedBoundedProfileMaximum,
      promotionEvaluationThreshold:
        result.admission.promotionEvaluationThreshold,
      hardStopThreshold: result.admission.hardStopThreshold,
    }),
    enforcedDefaultLimits: Object.freeze({
      zip: LINKEDIN_ARCHIVE_ZIP_DEFAULT_LIMITS,
      importer: LINKEDIN_ARCHIVE_IMPORT_DEFAULT_LIMITS,
    }),
  });
}
