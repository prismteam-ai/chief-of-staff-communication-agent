export const LINKEDIN_SYNTHETIC_MARKER =
  'VISIBLE_SYNTHETIC_LINKEDIN_EXPORT_V1' as const;

export type LinkedinArchiveProvenance =
  | {
      readonly sourceKind: 'user_export';
      readonly userProvided: true;
      readonly exportLabel: string;
    }
  | {
      readonly sourceKind: 'synthetic_fixture';
      readonly syntheticMarker: typeof LINKEDIN_SYNTHETIC_MARKER;
      readonly exportLabel: string;
    };

export interface LinkedinArchiveEntry {
  readonly path: string;
  readonly declaredSizeBytes: number;
  readonly bytes: AsyncIterable<Uint8Array>;
}

export interface LinkedinArchiveParticipant {
  readonly participantId: string;
  readonly displayName: string;
  readonly profileUrl?: string;
}

export interface LinkedinArchiveAttachment {
  readonly attachmentId: string;
  readonly sourceReference: string;
  readonly fileName?: string;
  readonly kind: 'archive_entry' | 'external_reference' | 'provider_metadata';
  readonly availability: 'present' | 'referenced_only' | 'unknown';
  readonly archivePath?: string;
  readonly sizeBytes?: number;
  readonly sha256?: string;
}

export interface LinkedinArchiveMessage {
  readonly messageId: string;
  readonly conversationId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly sourceTimestamp: string;
  readonly senderParticipantId: string;
  readonly recipientParticipantIds: readonly string[];
  readonly subject?: string;
  readonly content: string;
  readonly folder?: string;
  readonly attachmentIds: readonly string[];
  readonly provenance: {
    readonly sourceEntryPath: string;
    readonly sourceRowNumber: number;
    readonly sourceRowSha256: string;
  };
}

export interface LinkedinArchiveConversation {
  readonly conversationId: string;
  readonly providerConversationId?: string;
  readonly title?: string;
  readonly participantIds: readonly string[];
  readonly messageIds: readonly string[];
  readonly firstMessageAt: string;
  readonly lastMessageAt: string;
}

export interface LinkedinArchiveIssue {
  readonly entryPath: string;
  readonly rowNumber: number;
  readonly code:
    | 'csv_syntax'
    | 'invalid_column_count'
    | 'missing_required_value'
    | 'invalid_timestamp'
    | 'invalid_attachment_metadata'
    | 'formula_cell_rejected';
  readonly column?: string;
}

export interface LinkedinArchiveAdmission {
  readonly admittedToRag: false;
  readonly status:
    | 'requires_explicit_admission_review'
    | 'requires_bounded_preselection_or_opensearch_promotion';
  readonly observedMessageCount: number;
  readonly expectedBoundedProfileMaximum: 6000;
  readonly promotionEvaluationThreshold: 8000;
  readonly hardStopThreshold: 10000;
  readonly requirements: readonly string[];
}

export interface LinkedinArchiveImportResult {
  readonly schemaVersion: '1';
  readonly tenantId: string;
  readonly accountId: string;
  readonly provenance: LinkedinArchiveProvenance & {
    readonly archiveSha256: string;
    readonly importedAt: string;
    readonly sourceEntryCount: number;
    readonly sourceByteCount: number;
  };
  readonly participants: readonly LinkedinArchiveParticipant[];
  readonly conversations: readonly LinkedinArchiveConversation[];
  readonly messages: readonly LinkedinArchiveMessage[];
  readonly attachments: readonly LinkedinArchiveAttachment[];
  readonly issues: readonly LinkedinArchiveIssue[];
  readonly duplicateRowCount: number;
  readonly malformedRowCount: number;
  readonly admission: LinkedinArchiveAdmission;
}

export interface LinkedinArchiveImportInput {
  readonly tenantId: string;
  readonly accountId: string;
  readonly importedAt: string;
  readonly provenance: LinkedinArchiveProvenance;
  readonly entries: AsyncIterable<LinkedinArchiveEntry>;
}

export interface LinkedinArchiveImportLimits {
  readonly maxEntries?: number;
  readonly maxArchiveBytes?: number;
  readonly maxCsvBytes?: number;
  readonly maxRows?: number;
  readonly maxRecordBytes?: number;
  readonly maxAttachmentsPerMessage?: number;
}

export interface LinkedinArchiveZipLimits {
  readonly maxContainerBytes?: number;
  readonly maxEntries?: number;
  readonly maxCompressedBytes?: number;
  readonly maxUncompressedBytes?: number;
  readonly maxCompressionRatio?: number;
}
