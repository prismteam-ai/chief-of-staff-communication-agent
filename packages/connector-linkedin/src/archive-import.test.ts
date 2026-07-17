import { describe, expect, it } from 'vitest';

import { importLinkedinArchive } from './archive-import.js';
import type { LinkedinArchiveEntry } from './archive-types.js';
import { LINKEDIN_SYNTHETIC_MARKER } from './archive-types.js';
import {
  createSyntheticLinkedinArchiveEntries,
  linkedinArchiveEntryFromBytes,
  SYNTHETIC_LINKEDIN_ATTACHMENT_BYTES,
  SYNTHETIC_LINKEDIN_MESSAGES_CSV_BYTES,
} from './fixtures.js';

const IMPORTED_AT = '2026-07-17T12:00:00.000Z';

function entries(
  ...values: readonly LinkedinArchiveEntry[]
): AsyncIterable<LinkedinArchiveEntry> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<LinkedinArchiveEntry> {
      let index = 0;
      return {
        next: () =>
          Promise.resolve(
            index < values.length
              ? {
                  done: false as const,
                  value: values[index++] as LinkedinArchiveEntry,
                }
              : { done: true as const, value: undefined },
          ),
      };
    },
  };
}

function syntheticInput(
  archiveEntries: AsyncIterable<LinkedinArchiveEntry>,
  tenantId = 'tenant-linkedin-a',
  accountId = 'account-linkedin-a',
) {
  return {
    tenantId,
    accountId,
    importedAt: IMPORTED_AT,
    provenance: {
      sourceKind: 'synthetic_fixture' as const,
      syntheticMarker: LINKEDIN_SYNTHETIC_MARKER,
      exportLabel: 'Clearly synthetic LinkedIn export fixture',
    },
    entries: archiveEntries,
  };
}

function csvBytes(rows: readonly string[]): Uint8Array {
  return new TextEncoder().encode(
    [
      'CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,DATE,SUBJECT,CONTENT,FOLDER,ATTACHMENTS',
      ...rows,
      '',
    ].join('\r\n'),
  );
}

describe('LinkedIn archive import', () => {
  it('streams provider-shaped bytes into deterministic conversations, participants, messages, and attachments', async () => {
    const first = await importLinkedinArchive(
      syntheticInput(createSyntheticLinkedinArchiveEntries()),
    );
    const replay = await importLinkedinArchive(
      syntheticInput(createSyntheticLinkedinArchiveEntries()),
    );

    expect(first).toEqual(replay);
    expect(first.provenance).toMatchObject({
      sourceKind: 'synthetic_fixture',
      sourceEntryCount: 2,
    });
    expect(first.messages).toHaveLength(2);
    expect(first.conversations).toHaveLength(1);
    expect(first.participants).toHaveLength(2);
    expect(
      first.participants.every(
        (participant) => participant.profileUrl !== undefined,
      ),
    ).toBe(true);
    expect(first.attachments).toHaveLength(1);
    expect(first.attachments[0]).toMatchObject({
      kind: 'archive_entry',
      availability: 'present',
      archivePath: 'Complete_LinkedInDataExport/attachments/launch-plan.txt',
    });
    expect(first.admission).toMatchObject({
      admittedToRag: false,
      status: 'requires_explicit_admission_review',
    });
  });

  it('normalizes deterministically regardless of safe archive entry order', async () => {
    const normal = await importLinkedinArchive(
      syntheticInput(createSyntheticLinkedinArchiveEntries()),
    );
    const reversed = await importLinkedinArchive(
      syntheticInput(
        entries(
          linkedinArchiveEntryFromBytes(
            'Complete_LinkedInDataExport/attachments/launch-plan.txt',
            SYNTHETIC_LINKEDIN_ATTACHMENT_BYTES,
          ),
          linkedinArchiveEntryFromBytes(
            'Complete_LinkedInDataExport/messages.csv',
            SYNTHETIC_LINKEDIN_MESSAGES_CSV_BYTES,
          ),
        ),
      ),
    );

    expect(reversed).toEqual(normal);
  });

  it('accepts bounded provider-added columns while requiring the canonical ten-column subset', async () => {
    const bytes = new TextEncoder().encode(
      [
        'Conversation Id,Conversation Title,From,Sender Profile Url,To,Recipient Profile Urls,Date,Subject,Content,Folder,Attachments,Message Id',
        'conversation-1,[SYNTHETIC] Expanded,[SYNTHETIC] Sender,,[SYNTHETIC] Recipient,,2026-07-16 08:30:00 UTC,,[SYNTHETIC] expanded provider row,INBOX,,provider-message-1',
        '',
      ].join('\r\n'),
    );
    const result = await importLinkedinArchive(
      syntheticInput(
        entries(linkedinArchiveEntryFromBytes('messages.csv', bytes)),
      ),
    );

    expect(result.messages).toHaveLength(1);
    expect(result.malformedRowCount).toBe(0);
  });

  it('checks formula injection in provider-added columns before ignoring them', async () => {
    const bytes = new TextEncoder().encode(
      [
        'Conversation Id,Conversation Title,From,Sender Profile Url,To,Recipient Profile Urls,Date,Subject,Content,Folder,Attachments,Message Id',
        'conversation-1,[SYNTHETIC] Expanded,[SYNTHETIC] Sender,,[SYNTHETIC] Recipient,,2026-07-16 08:30:00 UTC,,[SYNTHETIC] expanded provider row,INBOX,,=1+1',
        '',
      ].join('\r\n'),
    );
    const result = await importLinkedinArchive(
      syntheticInput(
        entries(linkedinArchiveEntryFromBytes('messages.csv', bytes)),
      ),
    );
    expect(result.messages).toHaveLength(0);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'formula_cell_rejected',
        column: 'EXTRA_COLUMN_12',
      }),
    ]);
  });

  it('deduplicates identical provider rows and preserves deterministic replay IDs', async () => {
    const text = new TextDecoder().decode(
      SYNTHETIC_LINKEDIN_MESSAGES_CSV_BYTES,
    );
    const lines = text.trimEnd().split('\r\n');
    const duplicated = new TextEncoder().encode(
      [...lines, lines[1], ''].join('\r\n'),
    );
    const result = await importLinkedinArchive(
      syntheticInput(
        entries(
          linkedinArchiveEntryFromBytes(
            'Complete_LinkedInDataExport/messages.csv',
            duplicated,
          ),
        ),
      ),
    );

    expect(result.messages).toHaveLength(2);
    expect(result.duplicateRowCount).toBe(1);
    expect(
      new Set(result.messages.map((message) => message.messageId)).size,
    ).toBe(2);
  });

  it('isolates stable IDs by tenant and connector account', async () => {
    const left = await importLinkedinArchive(
      syntheticInput(createSyntheticLinkedinArchiveEntries()),
    );
    const right = await importLinkedinArchive(
      syntheticInput(
        createSyntheticLinkedinArchiveEntries(),
        'tenant-linkedin-b',
        'account-linkedin-b',
      ),
    );

    expect(left.messages.map(({ messageId }) => messageId)).not.toEqual(
      right.messages.map(({ messageId }) => messageId),
    );
    expect(left.conversations[0]?.conversationId).not.toBe(
      right.conversations[0]?.conversationId,
    );
    expect(
      left.participants.map(({ participantId }) => participantId),
    ).not.toEqual(right.participants.map(({ participantId }) => participantId));
  });

  it('records malformed rows without leaking their contents or abandoning valid rows', async () => {
    const bytes = csvBytes([
      'conversation-1,[SYNTHETIC] Valid,[SYNTHETIC] Sender,,[SYNTHETIC] Recipient,2026-07-16 08:30:00 UTC,,[SYNTHETIC] valid,INBOX,',
      'conversation-2,[SYNTHETIC] Bad date,[SYNTHETIC] Sender,,[SYNTHETIC] Recipient,not-a-date,,[SYNTHETIC] secret body,INBOX,',
      'conversation-3,[SYNTHETIC] Missing sender,,,[SYNTHETIC] Recipient,2026-07-16 08:31:00 UTC,,[SYNTHETIC] hidden body,INBOX,',
    ]);
    const result = await importLinkedinArchive(
      syntheticInput(
        entries(linkedinArchiveEntryFromBytes('messages.csv', bytes, 5)),
      ),
    );

    expect(result.messages).toHaveLength(1);
    expect(result.malformedRowCount).toBe(2);
    expect(result.issues).toEqual([
      {
        entryPath: 'messages.csv',
        rowNumber: 3,
        code: 'invalid_timestamp',
        column: 'DATE',
      },
      {
        entryPath: 'messages.csv',
        rowNumber: 4,
        code: 'missing_required_value',
      },
    ]);
    expect(JSON.stringify(result.issues)).not.toContain('secret body');
    expect(JSON.stringify(result.issues)).not.toContain('hidden body');
  });

  it('rejects calendar-normalized timestamps as malformed instead of changing their date', async () => {
    const bytes = csvBytes([
      'conversation-1,[SYNTHETIC] Bad calendar date,[SYNTHETIC] Sender,,[SYNTHETIC] Recipient,2026-02-30 08:30:00 UTC,,[SYNTHETIC] invalid date,INBOX,',
    ]);
    const result = await importLinkedinArchive(
      syntheticInput(
        entries(linkedinArchiveEntryFromBytes('messages.csv', bytes)),
      ),
    );

    expect(result.messages).toHaveLength(0);
    expect(result.issues).toEqual([
      {
        entryPath: 'messages.csv',
        rowNumber: 2,
        code: 'invalid_timestamp',
        column: 'DATE',
      },
    ]);
  });

  it.each([
    '=HYPERLINK("https://attacker.invalid")',
    '+cmd|calc',
    '-2+3',
    '@SUM(1,1)',
    '  =1+1',
  ])(
    'rejects CSV formula payloads before normalization: %s',
    async (payload) => {
      const escaped = `"${payload.replaceAll('"', '""')}"`;
      const bytes = csvBytes([
        `conversation-1,[SYNTHETIC] Formula,[SYNTHETIC] Sender,,[SYNTHETIC] Recipient,2026-07-16 08:30:00 UTC,,${escaped},INBOX,`,
      ]);

      const result = await importLinkedinArchive(
        syntheticInput(
          entries(linkedinArchiveEntryFromBytes('messages.csv', bytes)),
        ),
      );
      expect(result.messages).toHaveLength(0);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: 'formula_cell_rejected',
          column: 'CONTENT',
        }),
      ]);
    },
  );

  it.each([
    '@colleague please review',
    '+1234567890',
    '- bullet-style reply',
    '-Thanks for the update',
  ])(
    'preserves non-formula communication text beginning with %s',
    async (content) => {
      const bytes = csvBytes([
        `conversation-1,[SYNTHETIC] Safe prefix,[SYNTHETIC] Sender,,[SYNTHETIC] Recipient,2026-07-16 08:30:00 UTC,,[SYNTHETIC] ${content},INBOX,`,
      ]);
      const result = await importLinkedinArchive(
        syntheticInput(
          entries(linkedinArchiveEntryFromBytes('messages.csv', bytes)),
        ),
      );

      expect(result.messages).toHaveLength(1);
    },
  );

  it.each([
    '../messages.csv',
    '/absolute/messages.csv',
    'C:/messages.csv',
    'safe\\..\\messages.csv',
    'safe/%2e%2e/messages.csv',
    'safe/../messages.csv',
  ])(
    'rejects unsafe archive paths without touching the filesystem: %s',
    async (path) => {
      await expect(
        importLinkedinArchive(
          syntheticInput(
            entries(
              linkedinArchiveEntryFromBytes(
                path,
                SYNTHETIC_LINKEDIN_MESSAGES_CSV_BYTES,
              ),
            ),
          ),
        ),
      ).rejects.toMatchObject({
        code: 'UNSAFE_ARCHIVE_PATH',
      });
    },
  );

  it('rejects an attachment traversal reference as an archive attack', async () => {
    const bytes = csvBytes([
      'conversation-1,[SYNTHETIC] Unsafe attachment,[SYNTHETIC] Sender,,[SYNTHETIC] Recipient,2026-07-16 08:30:00 UTC,,[SYNTHETIC] attachment traversal,INBOX,../secret.txt',
    ]);
    await expect(
      importLinkedinArchive(
        syntheticInput(
          entries(linkedinArchiveEntryFromBytes('exports/messages.csv', bytes)),
        ),
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_ARCHIVE_PATH' });
  });

  it('requires explicit user-export provenance or the visible synthetic marker', async () => {
    await expect(
      importLinkedinArchive({
        ...syntheticInput(createSyntheticLinkedinArchiveEntries()),
        provenance: {
          sourceKind: 'synthetic_fixture',
          syntheticMarker: 'WRONG' as typeof LINKEDIN_SYNTHETIC_MARKER,
          exportLabel: 'not proven',
        },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_PROVENANCE',
    });

    const userExport = await importLinkedinArchive({
      tenantId: 'tenant-linkedin-a',
      accountId: 'account-linkedin-a',
      importedAt: IMPORTED_AT,
      provenance: {
        sourceKind: 'user_export',
        userProvided: true,
        exportLabel: 'User-provided export',
      },
      entries: createSyntheticLinkedinArchiveEntries(),
    });
    expect(userExport.provenance.sourceKind).toBe('user_export');
  });

  it('keeps large archives out of RAG and reports bounded-profile promotion requirements', async () => {
    const rows = Array.from({ length: 6001 }, (_, index) =>
      [
        `conversation-${index}`,
        '[SYNTHETIC] Large export',
        '[SYNTHETIC] Sender',
        '',
        '[SYNTHETIC] Recipient',
        '2026-07-16 08:30:00 UTC',
        '',
        `[SYNTHETIC] message ${index}`,
        'INBOX',
        '',
      ].join(','),
    );
    const bytes = csvBytes(rows);
    const result = await importLinkedinArchive(
      syntheticInput(
        entries(linkedinArchiveEntryFromBytes('messages.csv', bytes, 4096)),
      ),
    );

    expect(result.messages).toHaveLength(6001);
    expect(result.admission).toMatchObject({
      admittedToRag: false,
      status: 'requires_bounded_preselection_or_opensearch_promotion',
      observedMessageCount: 6001,
      expectedBoundedProfileMaximum: 6000,
      promotionEvaluationThreshold: 8000,
      hardStopThreshold: 10000,
    });
  });

  it('enforces declared byte and row bounds while streaming', async () => {
    await expect(
      importLinkedinArchive(
        syntheticInput(createSyntheticLinkedinArchiveEntries()),
        { maxCsvBytes: 100 },
      ),
    ).rejects.toMatchObject({
      code: 'CSV_BYTE_LIMIT_EXCEEDED',
    });

    await expect(
      importLinkedinArchive(
        syntheticInput(createSyntheticLinkedinArchiveEntries()),
        { maxRows: 1 },
      ),
    ).rejects.toMatchObject({
      code: 'CSV_ROW_LIMIT_EXCEEDED',
    });

    const dishonest = linkedinArchiveEntryFromBytes(
      'messages.csv',
      SYNTHETIC_LINKEDIN_MESSAGES_CSV_BYTES,
    );
    await expect(
      importLinkedinArchive(
        syntheticInput(
          entries({
            ...dishonest,
            declaredSizeBytes: dishonest.declaredSizeBytes - 1,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'DECLARED_SIZE_MISMATCH' });
  });
});
