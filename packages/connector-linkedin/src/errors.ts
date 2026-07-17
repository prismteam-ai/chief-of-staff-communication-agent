export type LinkedinArchiveImportErrorCode =
  | 'INVALID_PROVENANCE'
  | 'UNSAFE_ARCHIVE_PATH'
  | 'DUPLICATE_ARCHIVE_PATH'
  | 'ARCHIVE_ENTRY_LIMIT_EXCEEDED'
  | 'ARCHIVE_BYTE_LIMIT_EXCEEDED'
  | 'DECLARED_SIZE_MISMATCH'
  | 'CSV_BYTE_LIMIT_EXCEEDED'
  | 'CSV_ROW_LIMIT_EXCEEDED'
  | 'CSV_FORMULA_CELL_REJECTED'
  | 'MESSAGES_CSV_MISSING'
  | 'MESSAGES_CSV_AMBIGUOUS'
  | 'MESSAGES_CSV_HEADER_MISMATCH'
  | 'SYNTHETIC_MARKER_NOT_VISIBLE';

export class LinkedinArchiveImportError extends Error {
  public constructor(
    public readonly code: LinkedinArchiveImportErrorCode,
    public readonly safeContext?: Readonly<{
      entryPath?: string;
      rowNumber?: number;
      column?: string;
    }>,
  ) {
    super(code);
    this.name = 'LinkedinArchiveImportError';
  }
}
