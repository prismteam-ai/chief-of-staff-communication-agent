import {
  immutableBlobRefSchema,
  type ImmutableBlobRef,
  type RetrievalDeltaManifest,
  type SyncCheckpoint,
} from '@chief/contracts';
import {
  PersistenceConflictError,
  type DynamoPersistence,
} from '@chief/persistence-dynamodb';

import type {
  CanonicalWrite,
  CommitResult,
  IngestionStore,
  IngestionWorkItem,
  ThreadMessageFact,
} from './types.js';

export interface ImmutableBodyWriter {
  put(input: {
    readonly tenantId: string;
    readonly body: string;
    readonly contentHash: string;
    readonly mediaType: string;
  }): Promise<ImmutableBlobRef>;
}

export interface DynamoIngestionStoreOptions {
  readonly persistence: DynamoPersistence;
  readonly bodyWriter: ImmutableBodyWriter;
  readonly coreTableName: string;
  readonly connectorRuntimeTableName: string;
  readonly threadLookupIndexName: string;
  readonly identityLookupIndexName: string;
  readonly asanaTopicLookupIndexName: string;
}

function lookupKey(...parts: readonly string[]): string {
  return parts.map((part) => `${String(part.length)}:${part}`).join('|');
}

function stringValue(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanValue(
  record: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

export class DynamoRepositoryIngestionStore implements IngestionStore {
  public constructor(private readonly options: DynamoIngestionStoreOptions) {}

  public async putBody(input: {
    readonly tenantId: string;
    readonly body: string;
    readonly contentHash: string;
    readonly mediaType: string;
  }): Promise<ImmutableBlobRef> {
    return immutableBlobRefSchema.parse(
      await this.options.bodyWriter.put(input),
    );
  }

  public async findIdentityCandidates(input: {
    readonly tenantId: string;
    readonly accountId: string;
    readonly identityDigests: readonly string[];
  }): Promise<
    readonly { readonly entityId: string; readonly evidenceRef: string }[]
  > {
    const pages = await Promise.all(
      input.identityDigests.map((digest) =>
        this.options.persistence.queryBounded(
          this.options.coreTableName,
          this.options.identityLookupIndexName,
          'identityLookupKey',
          lookupKey(input.tenantId, digest),
          100,
        ),
      ),
    );
    const candidates = pages.flat().flatMap((record) => {
      const accountId = stringValue(record, 'accountId');
      const entityId = stringValue(record, 'personId');
      const evidenceRef = stringValue(record, 'revisionId');
      return accountId === undefined ||
        accountId === input.accountId ||
        entityId === undefined ||
        evidenceRef === undefined
        ? []
        : [{ entityId, evidenceRef }];
    });
    return Object.freeze([
      ...new Map(
        candidates.map((candidate) => [candidate.entityId, candidate]),
      ).values(),
    ]);
  }

  public async findAsanaCandidates(input: {
    readonly tenantId: string;
    readonly topicTerms: readonly string[];
  }): Promise<
    readonly { readonly objectId: string; readonly evidenceRef: string }[]
  > {
    const pages = await Promise.all(
      input.topicTerms.map((term) =>
        this.options.persistence.queryBounded(
          this.options.coreTableName,
          this.options.asanaTopicLookupIndexName,
          'asanaTopicLookupKey',
          lookupKey(input.tenantId, term),
          100,
        ),
      ),
    );
    const candidates = pages.flat().flatMap((record) => {
      const objectId = stringValue(record, 'providerObjectId');
      const evidenceRef = stringValue(record, 'dedupeKey');
      return objectId === undefined || evidenceRef === undefined
        ? []
        : [{ objectId, evidenceRef }];
    });
    return Object.freeze([
      ...new Map(
        candidates.map((candidate) => [candidate.objectId, candidate]),
      ).values(),
    ]);
  }

  public async threadFacts(input: {
    readonly tenantId: string;
    readonly threadId: string;
  }): Promise<readonly ThreadMessageFact[]> {
    const records = await this.options.persistence.queryBounded(
      this.options.coreTableName,
      this.options.threadLookupIndexName,
      'threadLookupKey',
      lookupKey(input.tenantId, input.threadId),
      100,
    );
    const facts = records.flatMap((record) => {
      const messageId = stringValue(record, 'messageId');
      const revisionId = stringValue(record, 'revisionId');
      const direction = stringValue(record, 'direction');
      const sourceTimestamp = stringValue(record, 'sourceTimestamp');
      const deleted = booleanValue(record, 'deleted');
      if (
        messageId === undefined ||
        revisionId === undefined ||
        (direction !== 'inbound' && direction !== 'outbound') ||
        sourceTimestamp === undefined ||
        deleted === undefined
      )
        return [];
      const safeDirection: 'inbound' | 'outbound' = direction;
      return [
        {
          messageId,
          revisionId,
          direction: safeDirection,
          sourceTimestamp,
          deleted,
        },
      ];
    });
    return Object.freeze(
      facts.sort(
        (left, right) =>
          left.sourceTimestamp.localeCompare(right.sourceTimestamp) ||
          left.revisionId.localeCompare(right.revisionId),
      ),
    );
  }

  public async commit(input: {
    readonly workItem: IngestionWorkItem;
    readonly canonical: CanonicalWrite;
    readonly checkpoint?: SyncCheckpoint;
    readonly retrievalDelta?: RetrievalDeltaManifest;
  }): Promise<CommitResult> {
    let duplicate = false;
    try {
      await this.options.persistence.putImmutableFactWithEvent({
        tableName: this.options.coreTableName,
        tenantId: input.workItem.tenantId,
        accountId: input.workItem.accountId,
        fact: {
          factType:
            input.canonical.source === 'asana'
              ? 'asana-source-revision'
              : 'message-source-revision',
          factId: input.canonical.dedupeKey,
          attributes: this.#factAttributes(
            input.workItem,
            input.canonical,
            input.retrievalDelta,
          ),
        },
        eventOutbox: {
          outboxId: `ingestion:${input.workItem.workItemId}:${input.canonical.contentHash}`,
          attributes: {
            eventType: input.canonical.deleted
              ? 'source.deleted'
              : 'source.ingested',
            aggregateId: input.canonical.dedupeKey,
            payloadHash: input.canonical.contentHash,
            status: 'pending',
            createdAt:
              input.canonical.source === 'asana'
                ? input.canonical.providerTimestamp
                : input.canonical.revision.ingestedAt,
          },
        },
      });
    } catch (error) {
      if (!(error instanceof PersistenceConflictError)) throw error;
      duplicate = true;
    }
    if (
      input.checkpoint !== undefined &&
      input.workItem.checkpoint !== undefined
    ) {
      try {
        await this.options.persistence.advanceCheckpoint({
          tableName: this.options.connectorRuntimeTableName,
          tenantId: input.workItem.tenantId,
          accountId: input.workItem.accountId,
          checkpointId: input.workItem.checkpoint.current.resourceScopeHash,
          expectedLeaseEpoch: input.workItem.checkpoint.current.leaseEpoch ?? 1,
          expectedCheckpointEpoch:
            input.workItem.checkpoint.current.checkpointEpoch,
          expectedVersion: input.workItem.checkpoint.current.checkpointEpoch,
          nextCheckpointEpoch: input.checkpoint.checkpointEpoch,
          nextVersion: input.checkpoint.checkpointEpoch,
          checkpoint: input.checkpoint,
        });
      } catch (error) {
        if (!(duplicate && error instanceof PersistenceConflictError))
          throw error;
      }
    }
    if (duplicate) return { status: 'duplicate' };
    if (input.canonical.deleted) return { status: 'deleted' };
    return {
      status:
        input.canonical.source === 'asana'
          ? input.canonical.providerVersion !== '1'
            ? 'updated'
            : 'created'
          : input.canonical.revision.revision > 1
            ? 'updated'
            : 'created',
    };
  }

  public async quarantine(input: {
    readonly workItem: IngestionWorkItem;
    readonly reasonCode: string;
    readonly detailHash: string;
  }): Promise<void> {
    try {
      await this.options.persistence.putImmutableFactWithEvent({
        tableName: this.options.connectorRuntimeTableName,
        tenantId: input.workItem.tenantId,
        accountId: input.workItem.accountId,
        fact: {
          factType: 'ingestion-quarantine',
          factId: input.workItem.workItemId,
          attributes: {
            reasonCode: input.reasonCode,
            detailHash: input.detailHash,
            source: input.workItem.source,
          },
        },
        eventOutbox: {
          outboxId: `quarantine:${input.workItem.workItemId}`,
          attributes: {
            eventType: 'ingestion.quarantined',
            aggregateId: input.workItem.workItemId,
            payloadHash: input.detailHash,
            status: 'pending',
          },
        },
      });
    } catch (error) {
      if (!(error instanceof PersistenceConflictError)) throw error;
    }
  }

  #factAttributes(
    workItem: IngestionWorkItem,
    canonical: CanonicalWrite,
    retrievalDelta: RetrievalDeltaManifest | undefined,
  ): Readonly<Record<string, unknown>> {
    const common = {
      source: canonical.source,
      dedupeKey: canonical.dedupeKey,
      contentHash: canonical.contentHash,
      connectorSnapshot: workItem.connectorSnapshot,
      rawReference: workItem.rawReference,
      ...(retrievalDelta === undefined ? {} : { retrievalDelta }),
    };
    if (canonical.source === 'asana')
      return {
        ...common,
        ...canonical,
        asanaTopicLookupKey:
          canonical.topicTerms[0] === undefined
            ? undefined
            : lookupKey(canonical.tenantId, canonical.topicTerms[0]),
      };
    const firstIdentity = canonical.identityDigests[0];
    return {
      ...common,
      message: canonical.message,
      revision: canonical.revision,
      thread: canonical.thread,
      attachments: canonical.attachments,
      topicLinks: canonical.topicLinks,
      answerState: canonical.answerState,
      messageId: canonical.message.messageId,
      revisionId: canonical.revision.revisionId,
      direction: canonical.revision.direction,
      sourceTimestamp: canonical.revision.sourceTimestamp,
      deleted: canonical.deleted,
      accountId: workItem.accountId,
      threadLookupKey: lookupKey(
        canonical.message.tenantId,
        canonical.thread.threadId,
      ),
      identityLookupKey:
        firstIdentity === undefined
          ? undefined
          : lookupKey(canonical.message.tenantId, firstIdentity),
      personId:
        firstIdentity === undefined ? undefined : `person_${firstIdentity}`,
    };
  }
}
