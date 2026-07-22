export interface ImapUidCheckpoint {
  readonly schemaVersion: '1';
  readonly folder: string;
  readonly uidValidity: string;
  readonly nextUid: number;
  readonly highestSeenUid: number;
}

export interface ImapSelectedFolder {
  readonly folder: string;
  readonly uidValidity: string;
  readonly uidNext: number;
}

export interface ImapFetchedMessage {
  readonly uid: number;
  readonly raw: Uint8Array;
}

export interface ImapPollSession {
  select(folder: string): Promise<ImapSelectedFolder>;
  fetchUidRange(input: {
    readonly folder: string;
    readonly startUid: number;
    readonly maxItems: number;
  }): Promise<readonly ImapFetchedMessage[]>;
  close(): Promise<void>;
}

export interface ImapSessionFactory {
  connect(): Promise<ImapPollSession>;
}

export type ImapPollOutcome =
  | {
      readonly status: 'complete';
      readonly messages: readonly ImapFetchedMessage[];
      readonly checkpoint: ImapUidCheckpoint;
      readonly reconnectCount: number;
    }
  | {
      readonly status: 'reset_required';
      readonly messages: readonly [];
      readonly checkpoint: ImapUidCheckpoint;
      readonly previousUidValidity: string;
      readonly reconnectCount: number;
    };

function assertCheckpoint(checkpoint: ImapUidCheckpoint): void {
  if (
    checkpoint.schemaVersion !== '1' ||
    checkpoint.folder.trim().length === 0 ||
    checkpoint.uidValidity.trim().length === 0 ||
    !Number.isSafeInteger(checkpoint.nextUid) ||
    checkpoint.nextUid < 1 ||
    !Number.isSafeInteger(checkpoint.highestSeenUid) ||
    checkpoint.highestSeenUid < 0
  ) {
    throw new Error('IMAP_UID_CHECKPOINT_INVALID');
  }
}

export async function pollImapUidCheckpoint(input: {
  readonly factory: ImapSessionFactory;
  readonly checkpoint: ImapUidCheckpoint;
  readonly maxItems: number;
  readonly maxReconnects: number;
}): Promise<ImapPollOutcome> {
  assertCheckpoint(input.checkpoint);
  if (
    !Number.isInteger(input.maxItems) ||
    input.maxItems < 1 ||
    input.maxItems > 1_000 ||
    !Number.isInteger(input.maxReconnects) ||
    input.maxReconnects < 0 ||
    input.maxReconnects > 3
  ) {
    throw new Error('IMAP_POLL_BUDGET_INVALID');
  }

  let reconnectCount = 0;
  for (;;) {
    let session: ImapPollSession | undefined;
    try {
      session = await input.factory.connect();
      const selected = await session.select(input.checkpoint.folder);
      if (selected.folder !== input.checkpoint.folder) {
        throw new Error('IMAP_FOLDER_SUBSTITUTION');
      }
      if (selected.uidValidity !== input.checkpoint.uidValidity) {
        return {
          status: 'reset_required',
          messages: [],
          previousUidValidity: input.checkpoint.uidValidity,
          checkpoint: {
            schemaVersion: '1',
            folder: selected.folder,
            uidValidity: selected.uidValidity,
            nextUid: 1,
            highestSeenUid: 0,
          },
          reconnectCount,
        };
      }
      const fetched = await session.fetchUidRange({
        folder: selected.folder,
        startUid: input.checkpoint.nextUid,
        maxItems: input.maxItems,
      });
      const messages = [...fetched]
        .filter((message) => message.uid >= input.checkpoint.nextUid)
        .sort((left, right) => left.uid - right.uid)
        .slice(0, input.maxItems);
      if (
        messages.some(
          (message, index) =>
            index > 0 && message.uid === messages[index - 1]?.uid,
        )
      ) {
        throw new Error('IMAP_DUPLICATE_UID_IN_PAGE');
      }
      const highestSeenUid =
        messages.at(-1)?.uid ?? input.checkpoint.highestSeenUid;
      return {
        status: 'complete',
        messages,
        checkpoint: {
          ...input.checkpoint,
          nextUid: highestSeenUid + 1,
          highestSeenUid,
        },
        reconnectCount,
      };
    } catch (error) {
      if (reconnectCount >= input.maxReconnects) {
        throw error;
      }
      reconnectCount += 1;
    } finally {
      await session?.close().catch(() => undefined);
    }
  }
}
