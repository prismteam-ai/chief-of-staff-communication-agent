export interface NormalizedParticipant {
  role: "from" | "to" | "cc" | "bcc";
  name?: string | null;
  address: string;
}

export interface NormalizedAttachment {
  externalId?: string | null;
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

export interface NormalizedMessage {
  externalId: string;
  threadExternalId?: string | null;
  threadSubject?: string | null;
  subject?: string | null;
  snippet?: string | null;
  body?: string | null;
  sentAt: Date;
  isOutbound: boolean;
  participants: NormalizedParticipant[];
  attachments: NormalizedAttachment[];
}

export interface IngestContext {
  userId: string;
  /** OAuth access token (oauth providers) */
  accessToken?: string;
  /** decrypted credentials (credential providers) */
  credentials?: Record<string, string>;
  /** provider-specific cursor from the previous sync */
  cursor?: string | null;
  /** account label of the connection (e.g. own email) to detect outbound */
  accountLabel?: string | null;
}

export interface IngestResult {
  messages: NormalizedMessage[];
  /** cursor to persist for the next incremental sync */
  nextCursor?: string | null;
}

export type Ingestor = (ctx: IngestContext) => Promise<IngestResult>;
