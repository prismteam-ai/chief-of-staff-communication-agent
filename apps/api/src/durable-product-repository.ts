import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import type { DynamoApprovalExecutionRecords } from '@chief/approval-outbox/dynamo-execution-persistence';
import { canonicalSha256 } from '@chief/approval-outbox/canonical';
import { PersistenceConflictError } from '@chief/persistence-dynamodb';

export interface DurableRevision<T = unknown> {
  readonly entityType: string;
  readonly entityId: string;
  readonly revisionId: string;
  readonly version: number;
  readonly committedAt: string;
  readonly value: T;
}

export interface RevisionWrite<T = unknown> extends DurableRevision<T> {
  readonly expectedVersion?: number;
  readonly expectedRevisionId?: string;
}

export interface AtomicCurrentHeadCondition {
  readonly entityType: string;
  readonly entityId: string;
  readonly revisionId: string;
  readonly version: number;
}

export interface AtomicApprovalWrite<T = unknown> {
  readonly expectedDraftHead: AtomicCurrentHeadCondition;
  readonly proposal: RevisionWrite<T> & {
    readonly expectedVersion: number;
    readonly expectedRevisionId: string;
  };
  readonly execution: DynamoApprovalExecutionRecords;
}

export interface AtomicRevisionWithExactLookup<T = unknown> {
  readonly revision: RevisionWrite<T>;
  readonly exactLookup: DurableRevision<T>;
}

export interface DurableProductRepository {
  getCurrent<T>(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Promise<DurableRevision<T> | undefined>;
  putRevision<T>(
    tenantId: string,
    write: RevisionWrite<T>,
  ): Promise<'created' | 'duplicate'>;
  getExact<T>(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Promise<DurableRevision<T> | undefined>;
  putRevisionWithExactLookup<T>(
    tenantId: string,
    input: AtomicRevisionWithExactLookup<T>,
  ): Promise<'created' | 'duplicate'>;
  approveAtomically<T>(
    tenantId: string,
    input: AtomicApprovalWrite<T>,
  ): Promise<'created' | 'duplicate'>;
}

function immutable<T>(value: T): T {
  return structuredClone(value);
}

function sameImmutableValue(left: unknown, right: unknown): boolean {
  return canonicalSha256(left) === canonicalSha256(right);
}

const INTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/u;

function internalKeyPart(value: string): string {
  if (!INTERNAL_ID.test(value)) throw new Error('INVALID_INTERNAL_ID');
  return Buffer.from(value, 'utf8').toString('base64url');
}

function coreEntityKey(
  tenantId: string,
  entityType: string,
  entityId: string,
): Readonly<{ PK: string; SK: string }> {
  return {
    PK: `T#${internalKeyPart(tenantId)}`,
    SK: `E#${internalKeyPart(entityType)}#${internalKeyPart(entityId)}`,
  };
}

function coreRevisionKey(
  tenantId: string,
  entityType: string,
  entityId: string,
  version: number,
  revisionId: string,
): Readonly<{ PK: string; SK: string }> {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error('INVALID_REVISION_VERSION');
  const head = coreEntityKey(tenantId, entityType, entityId);
  return {
    PK: head.PK,
    SK: `${head.SK}#REV#${version.toString().padStart(12, '0')}#${internalKeyPart(revisionId)}`,
  };
}

interface MemoryHead {
  readonly version: number;
  readonly revisionId: string;
}

/** Production-shaped test adapter: immutable revisions plus a CAS head. */
export class MemoryDurableProductRepository implements DurableProductRepository {
  readonly #heads = new Map<string, MemoryHead>();
  readonly #revisions = new Map<string, DurableRevision>();
  readonly #execution = new Map<string, DynamoApprovalExecutionRecords>();
  readonly #exact = new Map<string, DurableRevision>();

  public getCurrent<T>(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Promise<DurableRevision<T> | undefined> {
    const prefix = this.#entityKey(tenantId, entityType, entityId);
    const head = this.#heads.get(prefix);
    if (head === undefined) return Promise.resolve(undefined);
    const revision = this.#revisions.get(
      `${prefix}#${head.version}#${head.revisionId}`,
    );
    return Promise.resolve(
      revision === undefined
        ? undefined
        : (immutable(revision) as DurableRevision<T>),
    );
  }

  public putRevision<T>(
    tenantId: string,
    write: RevisionWrite<T>,
  ): Promise<'created' | 'duplicate'> {
    const prefix = this.#entityKey(tenantId, write.entityType, write.entityId);
    const revisionKey = `${prefix}#${write.version}#${write.revisionId}`;
    const expectedRevision: DurableRevision<T> = {
      entityType: write.entityType,
      entityId: write.entityId,
      revisionId: write.revisionId,
      version: write.version,
      committedAt: write.committedAt,
      value: write.value,
    };
    const existingRevision = this.#revisions.get(revisionKey);
    if (existingRevision !== undefined) {
      if (sameImmutableValue(existingRevision, expectedRevision))
        return Promise.resolve('duplicate');
      throw new PersistenceConflictError();
    }
    const head = this.#heads.get(prefix);
    if (
      head === undefined
        ? write.version !== 1 || write.expectedVersion !== undefined
        : write.expectedVersion !== head.version ||
          write.expectedRevisionId !== head.revisionId ||
          write.version !== head.version + 1
    ) {
      throw new PersistenceConflictError();
    }
    const revision = immutable(expectedRevision);
    this.#revisions.set(revisionKey, revision);
    this.#heads.set(prefix, {
      version: write.version,
      revisionId: write.revisionId,
    });
    return Promise.resolve('created');
  }

  public getExact<T>(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Promise<DurableRevision<T> | undefined> {
    const value = this.#exact.get(
      this.#entityKey(tenantId, entityType, entityId),
    );
    return Promise.resolve(
      value === undefined
        ? undefined
        : (immutable(value) as DurableRevision<T>),
    );
  }

  public putRevisionWithExactLookup<T>(
    tenantId: string,
    input: AtomicRevisionWithExactLookup<T>,
  ): Promise<'created' | 'duplicate'> {
    const write = input.revision;
    const prefix = this.#entityKey(tenantId, write.entityType, write.entityId);
    const revisionKey = `${prefix}#${write.version}#${write.revisionId}`;
    const expectedRevision: DurableRevision<T> = {
      entityType: write.entityType,
      entityId: write.entityId,
      revisionId: write.revisionId,
      version: write.version,
      committedAt: write.committedAt,
      value: write.value,
    };
    const exactKey = this.#entityKey(
      tenantId,
      input.exactLookup.entityType,
      input.exactLookup.entityId,
    );
    const existingRevision = this.#revisions.get(revisionKey);
    const existingExact = this.#exact.get(exactKey);
    if (existingRevision !== undefined || existingExact !== undefined) {
      if (
        existingRevision !== undefined &&
        existingExact !== undefined &&
        sameImmutableValue(existingRevision, expectedRevision) &&
        sameImmutableValue(existingExact, input.exactLookup)
      )
        return Promise.resolve('duplicate');
      throw new PersistenceConflictError();
    }
    const head = this.#heads.get(prefix);
    if (
      head === undefined
        ? write.version !== 1 || write.expectedVersion !== undefined
        : write.expectedVersion !== head.version ||
          write.expectedRevisionId !== head.revisionId ||
          write.version !== head.version + 1
    )
      throw new PersistenceConflictError();
    this.#revisions.set(revisionKey, immutable(expectedRevision));
    this.#heads.set(prefix, {
      version: write.version,
      revisionId: write.revisionId,
    });
    this.#exact.set(exactKey, immutable(input.exactLookup));
    return Promise.resolve('created');
  }

  public approveAtomically<T>(
    tenantId: string,
    input: AtomicApprovalWrite<T>,
  ): Promise<'created' | 'duplicate'> {
    if (!this.#matchesCurrentHead(tenantId, input.expectedDraftHead))
      throw new PersistenceConflictError();
    const operationId = input.execution.aggregate.operationId;
    const existingExecution = this.#execution.get(operationId);
    const prefix = this.#entityKey(
      tenantId,
      input.proposal.entityType,
      input.proposal.entityId,
    );
    const revisionKey = `${prefix}#${input.proposal.version}#${input.proposal.revisionId}`;
    const expectedProposal: DurableRevision<T> = {
      entityType: input.proposal.entityType,
      entityId: input.proposal.entityId,
      revisionId: input.proposal.revisionId,
      version: input.proposal.version,
      committedAt: input.proposal.committedAt,
      value: input.proposal.value,
    };
    if (existingExecution !== undefined) {
      const existingProposal = this.#revisions.get(revisionKey);
      if (
        existingProposal !== undefined &&
        sameImmutableValue(existingProposal, expectedProposal) &&
        sameImmutableValue(existingExecution, input.execution)
      )
        return Promise.resolve('duplicate');
      throw new PersistenceConflictError();
    }
    if (this.#revisions.has(revisionKey)) throw new PersistenceConflictError();
    const proposalHead = this.#heads.get(prefix);
    if (
      proposalHead === undefined ||
      input.proposal.expectedVersion !== proposalHead.version ||
      input.proposal.expectedRevisionId !== proposalHead.revisionId ||
      input.proposal.version !== proposalHead.version + 1
    )
      throw new PersistenceConflictError();
    const persistedProposal = immutable(expectedProposal);
    const persistedExecution = immutable(input.execution);
    this.#revisions.set(revisionKey, persistedProposal);
    this.#heads.set(prefix, {
      version: input.proposal.version,
      revisionId: input.proposal.revisionId,
    });
    this.#execution.set(operationId, persistedExecution);
    return Promise.resolve('created');
  }

  public executionRecord(
    operationId: string,
  ): DynamoApprovalExecutionRecords | undefined {
    const value = this.#execution.get(operationId);
    return value === undefined ? undefined : immutable(value);
  }

  #entityKey(tenantId: string, entityType: string, entityId: string): string {
    return `${tenantId}\u0000${entityType}\u0000${entityId}`;
  }

  #matchesCurrentHead(
    tenantId: string,
    expected: AtomicCurrentHeadCondition,
  ): boolean {
    const head = this.#heads.get(
      this.#entityKey(tenantId, expected.entityType, expected.entityId),
    );
    return (
      head?.revisionId === expected.revisionId &&
      head.version === expected.version
    );
  }
}

export class DynamoDurableProductRepository implements DurableProductRepository {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async getCurrent<T>(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Promise<DurableRevision<T> | undefined> {
    const head = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: coreEntityKey(tenantId, entityType, entityId),
        ConsistentRead: true,
      }),
    );
    const headItem = head.Item as Record<string, unknown> | undefined;
    const currentRevisionSk = headItem?.currentRevisionSk;
    if (typeof currentRevisionSk !== 'string') return undefined;
    const revision = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: headItem?.PK, SK: currentRevisionSk },
        ConsistentRead: true,
      }),
    );
    const item = revision.Item as Record<string, unknown> | undefined;
    if (
      item === undefined ||
      item.tenantId !== tenantId ||
      item.entityType !== entityType ||
      item.entityId !== entityId ||
      typeof item.revisionId !== 'string' ||
      typeof item.version !== 'number' ||
      typeof item.committedAt !== 'string' ||
      item.value === undefined
    ) {
      throw new Error('MALFORMED_DURABLE_PRODUCT_REVISION');
    }
    return {
      entityType,
      entityId,
      revisionId: item.revisionId,
      version: item.version,
      committedAt: item.committedAt,
      value: item.value as T,
    };
  }

  public async putRevision<T>(
    tenantId: string,
    write: RevisionWrite<T>,
  ): Promise<'created' | 'duplicate'> {
    const headKey = coreEntityKey(tenantId, write.entityType, write.entityId);
    const revisionKey = coreRevisionKey(
      tenantId,
      write.entityType,
      write.entityId,
      write.version,
      write.revisionId,
    );
    const create = write.expectedVersion === undefined;
    if (
      create
        ? write.version !== 1 || write.expectedRevisionId !== undefined
        : write.expectedRevisionId === undefined ||
          write.version !== write.expectedVersion + 1
    )
      throw new Error('INVALID_REVISION_TRANSITION');
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...revisionKey,
                  tenantId,
                  entityType: write.entityType,
                  entityId: write.entityId,
                  revisionId: write.revisionId,
                  version: write.version,
                  committedAt: write.committedAt,
                  committedAtEpochMs: Date.parse(write.committedAt),
                  immutable: true,
                  value: write.value,
                },
                ConditionExpression:
                  'attribute_not_exists(PK) AND attribute_not_exists(SK)',
              },
            },
            create
              ? {
                  Put: {
                    TableName: this.tableName,
                    Item: {
                      ...headKey,
                      tenantId,
                      entityType: write.entityType,
                      entityId: write.entityId,
                      version: write.version,
                      currentRevisionId: write.revisionId,
                      currentRevisionSk: revisionKey.SK,
                      updatedAtEpochMs: Date.parse(write.committedAt),
                    },
                    ConditionExpression:
                      'attribute_not_exists(PK) AND attribute_not_exists(SK)',
                  },
                }
              : {
                  Update: {
                    TableName: this.tableName,
                    Key: headKey,
                    ConditionExpression:
                      '#tenant = :tenant AND #version = :expectedVersion AND #revision = :expectedRevision',
                    UpdateExpression:
                      'SET #version = :nextVersion, #revision = :nextRevision, #revisionSk = :nextRevisionSk, #updated = :updated',
                    ExpressionAttributeNames: {
                      '#tenant': 'tenantId',
                      '#version': 'version',
                      '#revision': 'currentRevisionId',
                      '#revisionSk': 'currentRevisionSk',
                      '#updated': 'updatedAtEpochMs',
                    },
                    ExpressionAttributeValues: {
                      ':tenant': tenantId,
                      ':expectedVersion': write.expectedVersion,
                      ':expectedRevision': write.expectedRevisionId,
                      ':nextVersion': write.version,
                      ':nextRevision': write.revisionId,
                      ':nextRevisionSk': revisionKey.SK,
                      ':updated': Date.parse(write.committedAt),
                    },
                  },
                },
          ],
        }),
      );
      return 'created';
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'TransactionCanceledException' &&
        (await this.#matchesRevision(tenantId, write))
      )
        return 'duplicate';
      if (
        error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'TransactionCanceledException'
      )
        throw new PersistenceConflictError();
      throw error;
    }
  }

  public async getExact<T>(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Promise<DurableRevision<T> | undefined> {
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: coreEntityKey(tenantId, entityType, entityId),
        ConsistentRead: true,
      }),
    );
    const item = output.Item as Record<string, unknown> | undefined;
    if (item === undefined) return undefined;
    if (
      item.tenantId !== tenantId ||
      item.entityType !== entityType ||
      item.entityId !== entityId ||
      typeof item.revisionId !== 'string' ||
      typeof item.version !== 'number' ||
      typeof item.committedAt !== 'string' ||
      item.value === undefined ||
      item.immutable !== true
    )
      throw new Error('MALFORMED_DURABLE_EXACT_LOOKUP');
    return {
      entityType,
      entityId,
      revisionId: item.revisionId,
      version: item.version,
      committedAt: item.committedAt,
      value: item.value as T,
    };
  }

  public async putRevisionWithExactLookup<T>(
    tenantId: string,
    input: AtomicRevisionWithExactLookup<T>,
  ): Promise<'created' | 'duplicate'> {
    const write = input.revision;
    const headKey = coreEntityKey(tenantId, write.entityType, write.entityId);
    const revisionKey = coreRevisionKey(
      tenantId,
      write.entityType,
      write.entityId,
      write.version,
      write.revisionId,
    );
    const exactKey = coreEntityKey(
      tenantId,
      input.exactLookup.entityType,
      input.exactLookup.entityId,
    );
    const create = write.expectedVersion === undefined;
    if (
      create
        ? write.version !== 1 || write.expectedRevisionId !== undefined
        : write.expectedRevisionId === undefined ||
          write.version !== write.expectedVersion + 1
    )
      throw new Error('INVALID_REVISION_TRANSITION');
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...revisionKey,
                  tenantId,
                  entityType: write.entityType,
                  entityId: write.entityId,
                  revisionId: write.revisionId,
                  version: write.version,
                  committedAt: write.committedAt,
                  committedAtEpochMs: Date.parse(write.committedAt),
                  immutable: true,
                  value: write.value,
                },
                ConditionExpression:
                  'attribute_not_exists(PK) AND attribute_not_exists(SK)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...exactKey,
                  tenantId,
                  ...input.exactLookup,
                  committedAtEpochMs: Date.parse(input.exactLookup.committedAt),
                  immutable: true,
                },
                ConditionExpression:
                  'attribute_not_exists(PK) AND attribute_not_exists(SK)',
              },
            },
            create
              ? {
                  Put: {
                    TableName: this.tableName,
                    Item: {
                      ...headKey,
                      tenantId,
                      entityType: write.entityType,
                      entityId: write.entityId,
                      version: write.version,
                      currentRevisionId: write.revisionId,
                      currentRevisionSk: revisionKey.SK,
                      updatedAtEpochMs: Date.parse(write.committedAt),
                    },
                    ConditionExpression:
                      'attribute_not_exists(PK) AND attribute_not_exists(SK)',
                  },
                }
              : {
                  Update: {
                    TableName: this.tableName,
                    Key: headKey,
                    ConditionExpression:
                      '#tenant = :tenant AND #version = :expectedVersion AND #revision = :expectedRevision',
                    UpdateExpression:
                      'SET #version = :nextVersion, #revision = :nextRevision, #revisionSk = :nextRevisionSk, #updated = :updated',
                    ExpressionAttributeNames: {
                      '#tenant': 'tenantId',
                      '#version': 'version',
                      '#revision': 'currentRevisionId',
                      '#revisionSk': 'currentRevisionSk',
                      '#updated': 'updatedAtEpochMs',
                    },
                    ExpressionAttributeValues: {
                      ':tenant': tenantId,
                      ':expectedVersion': write.expectedVersion,
                      ':expectedRevision': write.expectedRevisionId,
                      ':nextVersion': write.version,
                      ':nextRevision': write.revisionId,
                      ':nextRevisionSk': revisionKey.SK,
                      ':updated': Date.parse(write.committedAt),
                    },
                  },
                },
          ],
        }),
      );
      return 'created';
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'TransactionCanceledException' &&
        (await this.#matchesRevision(tenantId, write)) &&
        (await this.#matchesExact(tenantId, input.exactLookup))
      )
        return 'duplicate';
      if (
        error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'TransactionCanceledException'
      )
        throw new PersistenceConflictError();
      throw error;
    }
  }

  public async approveAtomically<T>(
    tenantId: string,
    input: AtomicApprovalWrite<T>,
  ): Promise<'created' | 'duplicate'> {
    const write = input.proposal;
    const expectedDraftHeadKey = coreEntityKey(
      tenantId,
      input.expectedDraftHead.entityType,
      input.expectedDraftHead.entityId,
    );
    const expectedDraftRevisionKey = coreRevisionKey(
      tenantId,
      input.expectedDraftHead.entityType,
      input.expectedDraftHead.entityId,
      input.expectedDraftHead.version,
      input.expectedDraftHead.revisionId,
    );
    const headKey = coreEntityKey(tenantId, write.entityType, write.entityId);
    const revisionKey = coreRevisionKey(
      tenantId,
      write.entityType,
      write.entityId,
      write.version,
      write.revisionId,
    );
    const executionPuts = [
      input.execution.locator,
      input.execution.aggregate,
      input.execution.authority,
    ].map((Item) => ({
      Put: {
        TableName: this.tableName,
        Item,
        ConditionExpression:
          'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      },
    }));
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: expectedDraftHeadKey,
                ConditionExpression:
                  '#tenant = :tenant AND #entityType = :entityType AND #entityId = :entityId AND #version = :version AND #revision = :revision AND #revisionSk = :revisionSk',
                ExpressionAttributeNames: {
                  '#tenant': 'tenantId',
                  '#entityType': 'entityType',
                  '#entityId': 'entityId',
                  '#version': 'version',
                  '#revision': 'currentRevisionId',
                  '#revisionSk': 'currentRevisionSk',
                },
                ExpressionAttributeValues: {
                  ':tenant': tenantId,
                  ':entityType': input.expectedDraftHead.entityType,
                  ':entityId': input.expectedDraftHead.entityId,
                  ':version': input.expectedDraftHead.version,
                  ':revision': input.expectedDraftHead.revisionId,
                  ':revisionSk': expectedDraftRevisionKey.SK,
                },
              },
            },
            ...executionPuts,
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...revisionKey,
                  tenantId,
                  entityType: write.entityType,
                  entityId: write.entityId,
                  revisionId: write.revisionId,
                  version: write.version,
                  committedAt: write.committedAt,
                  committedAtEpochMs: Date.parse(write.committedAt),
                  immutable: true,
                  value: write.value,
                },
                ConditionExpression:
                  'attribute_not_exists(PK) AND attribute_not_exists(SK)',
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: headKey,
                ConditionExpression:
                  '#tenant = :tenant AND #version = :expectedVersion AND #revision = :expectedRevision',
                UpdateExpression:
                  'SET #version = :nextVersion, #revision = :nextRevision, #revisionSk = :nextRevisionSk, #updated = :updated',
                ExpressionAttributeNames: {
                  '#tenant': 'tenantId',
                  '#version': 'version',
                  '#revision': 'currentRevisionId',
                  '#revisionSk': 'currentRevisionSk',
                  '#updated': 'updatedAtEpochMs',
                },
                ExpressionAttributeValues: {
                  ':tenant': tenantId,
                  ':expectedVersion': write.expectedVersion,
                  ':expectedRevision': write.expectedRevisionId,
                  ':nextVersion': write.version,
                  ':nextRevision': write.revisionId,
                  ':nextRevisionSk': revisionKey.SK,
                  ':updated': Date.parse(write.committedAt),
                },
              },
            },
          ],
        }),
      );
      return 'created';
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'TransactionCanceledException' &&
        (await this.#matchesApproval(tenantId, input))
      ) {
        return 'duplicate';
      }
      if (
        error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'TransactionCanceledException'
      )
        throw new PersistenceConflictError();
      throw error;
    }
  }

  async #matchesRevision<T>(
    tenantId: string,
    write: RevisionWrite<T>,
  ): Promise<boolean> {
    const key = coreRevisionKey(
      tenantId,
      write.entityType,
      write.entityId,
      write.version,
      write.revisionId,
    );
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: key,
        ConsistentRead: true,
      }),
    );
    const item = output.Item as Record<string, unknown> | undefined;
    if (item === undefined) return false;
    return sameImmutableValue(
      {
        entityType: item.entityType,
        entityId: item.entityId,
        revisionId: item.revisionId,
        version: item.version,
        committedAt: item.committedAt,
        value: item.value,
      },
      {
        entityType: write.entityType,
        entityId: write.entityId,
        revisionId: write.revisionId,
        version: write.version,
        committedAt: write.committedAt,
        value: write.value,
      },
    );
  }

  async #matchesExact<T>(
    tenantId: string,
    expected: DurableRevision<T>,
  ): Promise<boolean> {
    const actual = await this.getExact<T>(
      tenantId,
      expected.entityType,
      expected.entityId,
    );
    return actual !== undefined && sameImmutableValue(actual, expected);
  }

  async #matchesApproval<T>(
    tenantId: string,
    input: AtomicApprovalWrite<T>,
  ): Promise<boolean> {
    if (!(await this.#matchesCurrentHead(tenantId, input.expectedDraftHead)))
      return false;
    if (!(await this.#matchesRevision(tenantId, input.proposal))) return false;
    const expected = [
      input.execution.locator,
      input.execution.aggregate,
      input.execution.authority,
    ];
    const actual = await Promise.all(
      expected.map(async (record) => {
        const output = await this.client.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { PK: record.PK, SK: record.SK },
            ConsistentRead: true,
          }),
        );
        return output.Item;
      }),
    );
    return actual.every(
      (record, index) =>
        record !== undefined && sameImmutableValue(record, expected[index]),
    );
  }

  async #matchesCurrentHead(
    tenantId: string,
    expected: AtomicCurrentHeadCondition,
  ): Promise<boolean> {
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: coreEntityKey(tenantId, expected.entityType, expected.entityId),
        ConsistentRead: true,
      }),
    );
    const item = output.Item as Record<string, unknown> | undefined;
    return (
      item?.tenantId === tenantId &&
      item.entityType === expected.entityType &&
      item.entityId === expected.entityId &&
      item.version === expected.version &&
      item.currentRevisionId === expected.revisionId &&
      item.currentRevisionSk ===
        coreRevisionKey(
          tenantId,
          expected.entityType,
          expected.entityId,
          expected.version,
          expected.revisionId,
        ).SK
    );
  }
}
