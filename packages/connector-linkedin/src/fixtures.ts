import type { LinkedinArchiveEntry } from './archive-types.js';

const SYNTHETIC_MESSAGES_CSV = [
  'CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,DATE,SUBJECT,CONTENT,FOLDER,ATTACHMENTS',
  'conversation-100,[SYNTHETIC] Launch planning,[SYNTHETIC] Alex Example,https://www.linkedin.com/in/synthetic-alex,[SYNTHETIC] Casey Example,2026-07-16 08:30:00 UTC,Synthetic launch,[SYNTHETIC] Can we review the launch plan?,INBOX,"[{""path"":""attachments/launch-plan.txt"",""name"":""launch-plan.txt""}]"',
  'conversation-100,[SYNTHETIC] Launch planning,[SYNTHETIC] Casey Example,https://www.linkedin.com/in/synthetic-casey,[SYNTHETIC] Alex Example,2026-07-16T09:00:00Z,Re: Synthetic launch,[SYNTHETIC] Yes - this record is fixture-only.,INBOX,',
  '',
].join('\r\n');

export const SYNTHETIC_LINKEDIN_MESSAGES_CSV_BYTES = new TextEncoder().encode(
  SYNTHETIC_MESSAGES_CSV,
);

export const SYNTHETIC_LINKEDIN_ATTACHMENT_BYTES = new TextEncoder().encode(
  '[SYNTHETIC] fixture attachment; no real LinkedIn data.',
);

function asyncValues<T>(values: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let index = 0;
      return {
        next: () =>
          Promise.resolve(
            index < values.length
              ? { done: false as const, value: values[index++] as T }
              : { done: true as const, value: undefined },
          ),
      };
    },
  };
}

function chunked(
  bytes: Uint8Array,
  chunkSize: number,
): AsyncIterable<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(
      bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength)),
    );
  }
  return asyncValues(chunks);
}

export function linkedinArchiveEntryFromBytes(
  path: string,
  bytes: Uint8Array,
  chunkSize = 17,
): LinkedinArchiveEntry {
  return {
    path,
    declaredSizeBytes: bytes.byteLength,
    bytes: chunked(bytes, chunkSize),
  };
}

export function createSyntheticLinkedinArchiveEntries(): AsyncIterable<LinkedinArchiveEntry> {
  return asyncValues([
    linkedinArchiveEntryFromBytes(
      'Complete_LinkedInDataExport/messages.csv',
      SYNTHETIC_LINKEDIN_MESSAGES_CSV_BYTES,
    ),
    linkedinArchiveEntryFromBytes(
      'Complete_LinkedInDataExport/attachments/launch-plan.txt',
      SYNTHETIC_LINKEDIN_ATTACHMENT_BYTES,
    ),
  ]);
}
