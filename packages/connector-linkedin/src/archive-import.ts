import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { dirname, join } from 'node:path/posix';

import { parse } from 'csv-parse';

import { normalizeArchivePath } from './archive-path.js';
import type {
  LinkedinArchiveAdmission,
  LinkedinArchiveAttachment,
  LinkedinArchiveConversation,
  LinkedinArchiveImportInput,
  LinkedinArchiveImportLimits,
  LinkedinArchiveImportResult,
  LinkedinArchiveIssue,
  LinkedinArchiveMessage,
  LinkedinArchiveParticipant,
} from './archive-types.js';
import { LINKEDIN_SYNTHETIC_MARKER } from './archive-types.js';
import { LinkedinArchiveImportError } from './errors.js';

const EXPECTED_HEADERS = [
  'CONVERSATION ID',
  'CONVERSATION TITLE',
  'FROM',
  'SENDER PROFILE URL',
  'TO',
  'DATE',
  'SUBJECT',
  'CONTENT',
  'FOLDER',
  'ATTACHMENTS',
] as const;

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 256,
  maxArchiveBytes: 128 * 1024 * 1024,
  maxCsvBytes: 64 * 1024 * 1024,
  maxRows: 100_000,
  maxRecordBytes: 1024 * 1024,
  maxAttachmentsPerMessage: 32,
});

interface EffectiveLimits {
  readonly maxEntries: number;
  readonly maxArchiveBytes: number;
  readonly maxCsvBytes: number;
  readonly maxRows: number;
  readonly maxRecordBytes: number;
  readonly maxAttachmentsPerMessage: number;
}

interface EntryFact {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface ParsedRow {
  readonly rowNumber: number;
  readonly providerConversationId?: string;
  readonly conversationTitle?: string;
  readonly from: string;
  readonly senderProfileUrl?: string;
  readonly to: readonly string[];
  readonly sourceTimestamp: string;
  readonly subject?: string;
  readonly content: string;
  readonly folder?: string;
  readonly attachmentReferences: readonly AttachmentReference[];
  readonly rowSha256: string;
}

interface AttachmentReference {
  readonly sourceReference: string;
  readonly fileName?: string;
  readonly kind: 'archive_entry' | 'external_reference' | 'provider_metadata';
  readonly archivePath?: string;
}

interface CsvInfoRecord {
  readonly record: unknown;
  readonly info?: { readonly lines?: number; readonly records?: number };
}

function positiveBound(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('archive import limits must be positive safe integers');
  }
  return Math.min(value, fallback);
}

function resolveLimits(
  overrides: LinkedinArchiveImportLimits,
): EffectiveLimits {
  return {
    maxEntries: positiveBound(overrides.maxEntries, DEFAULT_LIMITS.maxEntries),
    maxArchiveBytes: positiveBound(
      overrides.maxArchiveBytes,
      DEFAULT_LIMITS.maxArchiveBytes,
    ),
    maxCsvBytes: positiveBound(
      overrides.maxCsvBytes,
      DEFAULT_LIMITS.maxCsvBytes,
    ),
    maxRows: positiveBound(overrides.maxRows, DEFAULT_LIMITS.maxRows),
    maxRecordBytes: positiveBound(
      overrides.maxRecordBytes,
      DEFAULT_LIMITS.maxRecordBytes,
    ),
    maxAttachmentsPerMessage: positiveBound(
      overrides.maxAttachmentsPerMessage,
      DEFAULT_LIMITS.maxAttachmentsPerMessage,
    ),
  };
}

function sha256(parts: readonly string[]): string {
  const digest = createHash('sha256');
  for (const part of parts) {
    digest.update(String(part.length));
    digest.update(':');
    digest.update(part);
    digest.update('|');
  }
  return digest.digest('hex');
}

function stableId(prefix: string, parts: readonly string[]): string {
  return `${prefix}_${sha256(parts)}`;
}

function trimmed(value: string): string | undefined {
  const result = value.trim();
  return result.length === 0 ? undefined : result;
}

function assertNoFormulaCell(
  value: string,
  entryPath: string,
  rowNumber: number,
  column: string,
): void {
  const candidate = value.replace(/^[\t\r ]+/u, '');
  if (/^[=+\-@]/u.test(candidate)) {
    throw new LinkedinArchiveImportError('CSV_FORMULA_CELL_REJECTED', {
      entryPath,
      rowNumber,
      column,
    });
  }
}

function parseTimestamp(value: string): string | undefined {
  const iso =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(
      value,
    );
  const linkedinUtc = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/u.exec(
    value,
  );
  const candidate =
    iso === null
      ? linkedinUtc === null
        ? undefined
        : `${linkedinUtc[1]}T${linkedinUtc[2]}.000Z`
      : `${iso[1]}T${iso[2]}.${(iso[3] ?? '').padEnd(3, '0') || '000'}${iso[4]}`;
  if (candidate === undefined) {
    return undefined;
  }
  const [year, month, day] = candidate
    .slice(0, 10)
    .split('-')
    .map((part) => Number(part));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  ) {
    return undefined;
  }
  const epoch = Date.parse(candidate);
  if (!Number.isFinite(epoch)) {
    return undefined;
  }
  return new Date(epoch).toISOString();
}

function parseRecipients(value: string): readonly string[] {
  return [...new Set(value.split(/[;|]/u).map((item) => item.trim()))]
    .filter((item) => item.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function safeExternalReference(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function resolveAttachmentReference(
  rawReference: string,
  fileName: string | undefined,
  messagesEntryPath: string,
): AttachmentReference {
  const sourceReference = rawReference.trim();
  if (sourceReference.includes('://')) {
    if (!safeExternalReference(sourceReference)) {
      throw new Error('unsupported attachment URI');
    }
    return {
      sourceReference,
      fileName,
      kind: 'external_reference',
    };
  }

  if (sourceReference.startsWith('urn:') || sourceReference.startsWith('id:')) {
    return {
      sourceReference,
      fileName,
      kind: 'provider_metadata',
    };
  }

  const base = dirname(messagesEntryPath);
  const safeRelativeReference = normalizeArchivePath(sourceReference);
  const archivePath = normalizeArchivePath(
    base === '.' ? safeRelativeReference : join(base, safeRelativeReference),
  );
  return {
    sourceReference,
    fileName: fileName ?? sourceReference.split('/').at(-1),
    kind: 'archive_entry',
    archivePath,
  };
}

function parseAttachmentReferences(
  value: string,
  messagesEntryPath: string,
  maxAttachments: number,
): readonly AttachmentReference[] {
  const raw = value.trim();
  if (raw.length === 0) {
    return [];
  }

  let candidates: readonly {
    readonly reference: string;
    readonly name?: string;
  }[];
  if (raw.startsWith('[')) {
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) {
      throw new Error('attachment metadata must be an array');
    }
    candidates = decoded.map((item) => {
      if (typeof item === 'string' && item.trim().length > 0) {
        return { reference: item };
      }
      if (item !== null && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const reference = record['path'] ?? record['url'] ?? record['id'];
        const name = record['name'];
        if (
          typeof reference === 'string' &&
          reference.trim().length > 0 &&
          (name === undefined || typeof name === 'string')
        ) {
          return { reference, ...(name === undefined ? {} : { name }) };
        }
      }
      throw new Error('invalid attachment metadata');
    });
  } else {
    candidates = raw
      .split(';')
      .map((reference) => ({ reference: reference.trim() }))
      .filter(({ reference }) => reference.length > 0);
  }

  if (candidates.length > maxAttachments) {
    throw new Error('attachment count exceeds limit');
  }
  return candidates.map(({ reference, name }) =>
    resolveAttachmentReference(reference, name, messagesEntryPath),
  );
}

function isCsvInfoRecord(value: unknown): value is CsvInfoRecord {
  return value !== null && typeof value === 'object' && 'record' in value;
}

async function parseMessagesCsv(
  entryPath: string,
  bytes: AsyncIterable<Uint8Array>,
  declaredSizeBytes: number,
  limits: EffectiveLimits,
  issues: LinkedinArchiveIssue[],
): Promise<{ readonly rows: readonly ParsedRow[]; readonly fact: EntryFact }> {
  const rows: ParsedRow[] = [];
  const digest = createHash('sha256');
  let actualSizeBytes = 0;
  let headerSeen = false;
  let fatalError: LinkedinArchiveImportError | undefined;

  const parser = parse({
    bom: true,
    columns: false,
    info: true,
    max_record_size: limits.maxRecordBytes,
    relax_column_count: true,
    skip_empty_lines: true,
    skip_records_with_error: true,
    on_skip: (error) => {
      issues.push({
        entryPath,
        rowNumber:
          typeof error?.lines === 'number' && Number.isFinite(error.lines)
            ? error.lines
            : 0,
        code: 'csv_syntax',
      });
      return undefined;
    },
  });

  const consume = (async () => {
    for await (const candidate of parser) {
      if (!isCsvInfoRecord(candidate) || !Array.isArray(candidate.record)) {
        continue;
      }
      const cells = candidate.record;
      if (!cells.every((cell) => typeof cell === 'string')) {
        continue;
      }
      const stringCells = cells;
      const rowNumber = candidate.info?.lines ?? rows.length + 1;
      if (!headerSeen) {
        headerSeen = true;
        if (
          stringCells.length !== EXPECTED_HEADERS.length ||
          stringCells.some((cell, index) => cell !== EXPECTED_HEADERS[index])
        ) {
          fatalError = new LinkedinArchiveImportError(
            'MESSAGES_CSV_HEADER_MISMATCH',
            { entryPath, rowNumber },
          );
        }
        continue;
      }
      if (fatalError !== undefined) {
        continue;
      }
      if (rows.length >= limits.maxRows) {
        fatalError = new LinkedinArchiveImportError('CSV_ROW_LIMIT_EXCEEDED', {
          entryPath,
          rowNumber,
        });
        continue;
      }
      if (stringCells.length !== EXPECTED_HEADERS.length) {
        issues.push({
          entryPath,
          rowNumber,
          code: 'invalid_column_count',
        });
        continue;
      }

      for (const [index, cell] of stringCells.entries()) {
        try {
          assertNoFormulaCell(
            cell,
            entryPath,
            rowNumber,
            EXPECTED_HEADERS[index] ?? 'UNKNOWN',
          );
        } catch (error) {
          if (error instanceof LinkedinArchiveImportError) {
            fatalError = error;
            break;
          }
          throw error;
        }
      }
      if (fatalError !== undefined) {
        continue;
      }

      const from = trimmed(stringCells[2] ?? '');
      const recipients = parseRecipients(stringCells[4] ?? '');
      const content = trimmed(stringCells[7] ?? '');
      if (
        from === undefined ||
        recipients.length === 0 ||
        content === undefined
      ) {
        issues.push({
          entryPath,
          rowNumber,
          code: 'missing_required_value',
        });
        continue;
      }
      const sourceTimestamp = parseTimestamp(stringCells[5] ?? '');
      if (sourceTimestamp === undefined) {
        issues.push({
          entryPath,
          rowNumber,
          code: 'invalid_timestamp',
          column: 'DATE',
        });
        continue;
      }

      let attachmentReferences: readonly AttachmentReference[];
      try {
        attachmentReferences = parseAttachmentReferences(
          stringCells[9] ?? '',
          entryPath,
          limits.maxAttachmentsPerMessage,
        );
      } catch (error) {
        if (error instanceof LinkedinArchiveImportError) {
          fatalError = error;
          continue;
        }
        issues.push({
          entryPath,
          rowNumber,
          code: 'invalid_attachment_metadata',
          column: 'ATTACHMENTS',
        });
        continue;
      }

      const normalizedParts = [
        trimmed(stringCells[0] ?? '') ?? '',
        trimmed(stringCells[1] ?? '') ?? '',
        from,
        trimmed(stringCells[3] ?? '') ?? '',
        ...recipients,
        sourceTimestamp,
        trimmed(stringCells[6] ?? '') ?? '',
        content,
        trimmed(stringCells[8] ?? '') ?? '',
        ...attachmentReferences.map((reference) => reference.sourceReference),
      ];
      rows.push({
        rowNumber,
        providerConversationId: trimmed(stringCells[0] ?? ''),
        conversationTitle: trimmed(stringCells[1] ?? ''),
        from,
        senderProfileUrl: trimmed(stringCells[3] ?? ''),
        to: recipients,
        sourceTimestamp,
        subject: trimmed(stringCells[6] ?? ''),
        content,
        folder: trimmed(stringCells[8] ?? ''),
        attachmentReferences,
        rowSha256: sha256(normalizedParts),
      });
    }
  })();

  for await (const chunk of bytes) {
    actualSizeBytes += chunk.byteLength;
    digest.update(chunk);
    if (actualSizeBytes > declaredSizeBytes) {
      parser.destroy();
      await consume.catch(() => undefined);
      throw new LinkedinArchiveImportError('DECLARED_SIZE_MISMATCH', {
        entryPath,
      });
    }
    if (actualSizeBytes > limits.maxCsvBytes) {
      parser.destroy();
      await consume.catch(() => undefined);
      throw new LinkedinArchiveImportError('CSV_BYTE_LIMIT_EXCEEDED', {
        entryPath,
      });
    }
    if (!parser.write(chunk)) {
      await once(parser, 'drain');
    }
  }
  parser.end();
  await consume;

  if (actualSizeBytes !== declaredSizeBytes) {
    throw new LinkedinArchiveImportError('DECLARED_SIZE_MISMATCH', {
      entryPath,
    });
  }
  if (fatalError !== undefined) {
    throw fatalError;
  }
  if (!headerSeen) {
    throw new LinkedinArchiveImportError('MESSAGES_CSV_HEADER_MISMATCH', {
      entryPath,
    });
  }
  return {
    rows,
    fact: {
      path: entryPath,
      sizeBytes: actualSizeBytes,
      sha256: digest.digest('hex'),
    },
  };
}

async function digestEntry(
  entryPath: string,
  bytes: AsyncIterable<Uint8Array>,
  declaredSizeBytes: number,
): Promise<EntryFact> {
  const digest = createHash('sha256');
  let actualSizeBytes = 0;
  for await (const chunk of bytes) {
    actualSizeBytes += chunk.byteLength;
    if (actualSizeBytes > declaredSizeBytes) {
      throw new LinkedinArchiveImportError('DECLARED_SIZE_MISMATCH', {
        entryPath,
      });
    }
    digest.update(chunk);
  }
  if (actualSizeBytes !== declaredSizeBytes) {
    throw new LinkedinArchiveImportError('DECLARED_SIZE_MISMATCH', {
      entryPath,
    });
  }
  return {
    path: entryPath,
    sizeBytes: actualSizeBytes,
    sha256: digest.digest('hex'),
  };
}

function validateProvenance(input: LinkedinArchiveImportInput): void {
  const sourceKind: unknown = Reflect.get(input.provenance, 'sourceKind');
  const userProvided: unknown = Reflect.get(input.provenance, 'userProvided');
  const syntheticMarker: unknown = Reflect.get(
    input.provenance,
    'syntheticMarker',
  );
  if (
    input.tenantId.trim().length === 0 ||
    input.accountId.trim().length === 0 ||
    input.provenance.exportLabel.trim().length === 0 ||
    !input.importedAt.includes('T') ||
    parseTimestamp(input.importedAt) === undefined ||
    (sourceKind !== 'user_export' && sourceKind !== 'synthetic_fixture') ||
    (sourceKind === 'user_export' && userProvided !== true) ||
    (sourceKind === 'synthetic_fixture' &&
      syntheticMarker !== LINKEDIN_SYNTHETIC_MARKER)
  ) {
    throw new LinkedinArchiveImportError('INVALID_PROVENANCE');
  }
}

function visibleSynthetic(row: ParsedRow): boolean {
  return [row.conversationTitle, row.from, ...row.to, row.content]
    .filter((value): value is string => value !== undefined)
    .some((value) => value.toUpperCase().includes('[SYNTHETIC]'));
}

function participantKey(
  tenantId: string,
  accountId: string,
  conversationId: string,
  displayName: string,
): readonly string[] {
  return [
    tenantId,
    accountId,
    conversationId,
    displayName.trim().toLocaleLowerCase('en-US'),
  ];
}

function admissionFor(messageCount: number): LinkedinArchiveAdmission {
  const tooLarge = messageCount > 6000;
  return {
    admittedToRag: false,
    status: tooLarge
      ? 'requires_bounded_preselection_or_opensearch_promotion'
      : 'requires_explicit_admission_review',
    observedMessageCount: messageCount,
    expectedBoundedProfileMaximum: 6000,
    promotionEvaluationThreshold: 8000,
    hardStopThreshold: 10000,
    requirements: Object.freeze(
      tooLarge
        ? [
            'Create a separately bounded, authorization-scoped preselection projection or promote the retrieval generation to OpenSearch.',
            'Re-run size, decoded-memory, latency, concurrency, freshness, quality, citation, and tenant-isolation gates before promotion.',
            'Keep the archive excluded from RAG until an immutable admission or promotion decision is approved.',
          ]
        : [
            'Run an explicit authorization-scoped RAG admission review; archive import alone never indexes content.',
            'Bind the resulting projection to the current retrieval profile and authorization epoch.',
          ],
    ),
  };
}

export async function importLinkedinArchive(
  input: LinkedinArchiveImportInput,
  limitOverrides: LinkedinArchiveImportLimits = {},
): Promise<LinkedinArchiveImportResult> {
  validateProvenance(input);
  const limits = resolveLimits(limitOverrides);
  const entryFacts = new Map<string, EntryFact>();
  const issues: LinkedinArchiveIssue[] = [];
  let parsedRows: readonly ParsedRow[] | undefined;
  let messagesEntryPath: string | undefined;
  let totalBytes = 0;
  let entryCount = 0;

  for await (const entry of input.entries) {
    entryCount += 1;
    if (entryCount > limits.maxEntries) {
      throw new LinkedinArchiveImportError('ARCHIVE_ENTRY_LIMIT_EXCEEDED');
    }
    if (
      !Number.isSafeInteger(entry.declaredSizeBytes) ||
      entry.declaredSizeBytes < 0
    ) {
      throw new LinkedinArchiveImportError('DECLARED_SIZE_MISMATCH');
    }
    totalBytes += entry.declaredSizeBytes;
    if (totalBytes > limits.maxArchiveBytes) {
      throw new LinkedinArchiveImportError('ARCHIVE_BYTE_LIMIT_EXCEEDED');
    }

    const safePath = normalizeArchivePath(entry.path);
    const pathKey = safePath.toLocaleLowerCase('en-US');
    if (
      [...entryFacts.keys()].some(
        (path) => path.toLocaleLowerCase('en-US') === pathKey,
      )
    ) {
      throw new LinkedinArchiveImportError('DUPLICATE_ARCHIVE_PATH', {
        entryPath: safePath,
      });
    }
    const isMessagesCsv =
      pathKey === 'messages.csv' || pathKey.endsWith('/messages.csv');
    if (isMessagesCsv) {
      if (messagesEntryPath !== undefined) {
        throw new LinkedinArchiveImportError('MESSAGES_CSV_AMBIGUOUS');
      }
      messagesEntryPath = safePath;
      const parsed = await parseMessagesCsv(
        safePath,
        entry.bytes,
        entry.declaredSizeBytes,
        limits,
        issues,
      );
      parsedRows = parsed.rows;
      entryFacts.set(safePath, parsed.fact);
    } else {
      const fact = await digestEntry(
        safePath,
        entry.bytes,
        entry.declaredSizeBytes,
      );
      entryFacts.set(safePath, fact);
    }
  }

  if (messagesEntryPath === undefined || parsedRows === undefined) {
    throw new LinkedinArchiveImportError('MESSAGES_CSV_MISSING');
  }
  if (
    input.provenance.sourceKind === 'synthetic_fixture' &&
    parsedRows.some((row) => !visibleSynthetic(row))
  ) {
    throw new LinkedinArchiveImportError('SYNTHETIC_MARKER_NOT_VISIBLE', {
      entryPath: messagesEntryPath,
    });
  }

  const participantMap = new Map<string, LinkedinArchiveParticipant>();
  const attachmentMap = new Map<string, LinkedinArchiveAttachment>();
  const messageMap = new Map<string, LinkedinArchiveMessage>();
  const conversationRows = new Map<
    string,
    {
      readonly providerConversationId?: string;
      readonly title?: string;
      readonly participantIds: Set<string>;
      readonly messageIds: Set<string>;
      firstMessageAt: string;
      lastMessageAt: string;
    }
  >();
  let duplicateRowCount = 0;

  for (const row of parsedRows) {
    const conversationId = stableId(
      'lic',
      row.providerConversationId === undefined
        ? [
            input.tenantId,
            input.accountId,
            'derived',
            row.conversationTitle ?? '',
            row.from,
            ...row.to,
          ]
        : [
            input.tenantId,
            input.accountId,
            'provider',
            row.providerConversationId,
          ],
    );
    const senderParticipantId = stableId(
      'lip',
      participantKey(input.tenantId, input.accountId, conversationId, row.from),
    );
    const existingSender = participantMap.get(senderParticipantId);
    participantMap.set(senderParticipantId, {
      participantId: senderParticipantId,
      displayName: row.from,
      ...(existingSender?.profileUrl === undefined &&
      row.senderProfileUrl === undefined
        ? {}
        : { profileUrl: existingSender?.profileUrl ?? row.senderProfileUrl }),
    });
    const recipientParticipantIds = row.to.map((displayName) => {
      const participantId = stableId(
        'lip',
        participantKey(
          input.tenantId,
          input.accountId,
          conversationId,
          displayName,
        ),
      );
      if (!participantMap.has(participantId)) {
        participantMap.set(participantId, { participantId, displayName });
      }
      return participantId;
    });

    const messageId = stableId('lim', [
      input.tenantId,
      input.accountId,
      conversationId,
      row.rowSha256,
    ]);
    if (messageMap.has(messageId)) {
      duplicateRowCount += 1;
      continue;
    }

    const attachmentIds = row.attachmentReferences.map((reference) => {
      const attachmentId = stableId('lia', [
        input.tenantId,
        input.accountId,
        messageId,
        reference.kind,
        reference.sourceReference,
      ]);
      const entryFact =
        reference.archivePath === undefined
          ? undefined
          : entryFacts.get(reference.archivePath);
      attachmentMap.set(attachmentId, {
        attachmentId,
        sourceReference: reference.sourceReference,
        ...(reference.fileName === undefined
          ? {}
          : { fileName: reference.fileName }),
        kind: reference.kind,
        availability:
          reference.kind === 'archive_entry'
            ? entryFact === undefined
              ? 'referenced_only'
              : 'present'
            : 'unknown',
        ...(reference.archivePath === undefined
          ? {}
          : { archivePath: reference.archivePath }),
        ...(entryFact === undefined
          ? {}
          : { sizeBytes: entryFact.sizeBytes, sha256: entryFact.sha256 }),
      });
      return attachmentId;
    });

    messageMap.set(messageId, {
      messageId,
      conversationId,
      tenantId: input.tenantId,
      accountId: input.accountId,
      sourceTimestamp: row.sourceTimestamp,
      senderParticipantId,
      recipientParticipantIds: Object.freeze(
        [...recipientParticipantIds].sort(),
      ),
      ...(row.subject === undefined ? {} : { subject: row.subject }),
      content: row.content,
      ...(row.folder === undefined ? {} : { folder: row.folder }),
      attachmentIds: Object.freeze([...attachmentIds].sort()),
      provenance: Object.freeze({
        sourceEntryPath: messagesEntryPath,
        sourceRowNumber: row.rowNumber,
        sourceRowSha256: row.rowSha256,
      }),
    });

    const existing = conversationRows.get(conversationId);
    const participantIds = [senderParticipantId, ...recipientParticipantIds];
    if (existing === undefined) {
      conversationRows.set(conversationId, {
        providerConversationId: row.providerConversationId,
        title: row.conversationTitle,
        participantIds: new Set(participantIds),
        messageIds: new Set([messageId]),
        firstMessageAt: row.sourceTimestamp,
        lastMessageAt: row.sourceTimestamp,
      });
    } else {
      participantIds.forEach((participantId) =>
        existing.participantIds.add(participantId),
      );
      existing.messageIds.add(messageId);
      if (row.sourceTimestamp < existing.firstMessageAt) {
        existing.firstMessageAt = row.sourceTimestamp;
      }
      if (row.sourceTimestamp > existing.lastMessageAt) {
        existing.lastMessageAt = row.sourceTimestamp;
      }
    }
  }

  const messages = [...messageMap.values()].sort(
    (left, right) =>
      left.sourceTimestamp.localeCompare(right.sourceTimestamp) ||
      left.messageId.localeCompare(right.messageId),
  );
  const conversations: LinkedinArchiveConversation[] = [...conversationRows]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([conversationId, conversation]) => ({
      conversationId,
      ...(conversation.providerConversationId === undefined
        ? {}
        : { providerConversationId: conversation.providerConversationId }),
      ...(conversation.title === undefined
        ? {}
        : { title: conversation.title }),
      participantIds: Object.freeze([...conversation.participantIds].sort()),
      messageIds: Object.freeze([...conversation.messageIds].sort()),
      firstMessageAt: conversation.firstMessageAt,
      lastMessageAt: conversation.lastMessageAt,
    }));
  const sortedEntryFacts = [...entryFacts.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const archiveSha256 = sha256(
    sortedEntryFacts.flatMap((fact) => [
      fact.path,
      String(fact.sizeBytes),
      fact.sha256,
    ]),
  );

  return Object.freeze({
    schemaVersion: '1' as const,
    tenantId: input.tenantId,
    accountId: input.accountId,
    provenance: Object.freeze({
      ...input.provenance,
      archiveSha256,
      importedAt: new Date(input.importedAt).toISOString(),
      sourceEntryCount: entryFacts.size,
      sourceByteCount: sortedEntryFacts.reduce(
        (total, fact) => total + fact.sizeBytes,
        0,
      ),
    }),
    participants: Object.freeze(
      [...participantMap.values()].sort((left, right) =>
        left.participantId.localeCompare(right.participantId),
      ),
    ),
    conversations: Object.freeze(conversations),
    messages: Object.freeze(messages),
    attachments: Object.freeze(
      [...attachmentMap.values()].sort((left, right) =>
        left.attachmentId.localeCompare(right.attachmentId),
      ),
    ),
    issues: Object.freeze(
      [...issues].sort(
        (left, right) =>
          left.entryPath.localeCompare(right.entryPath) ||
          left.rowNumber - right.rowNumber ||
          left.code.localeCompare(right.code),
      ),
    ),
    duplicateRowCount,
    malformedRowCount: issues.length,
    admission: Object.freeze(admissionFor(messages.length)),
  });
}
