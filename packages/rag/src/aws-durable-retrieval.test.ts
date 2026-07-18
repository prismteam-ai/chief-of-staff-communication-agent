import { createHash } from 'node:crypto';

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { immutableBlobRefSchema } from '@chief/contracts/storage';
import { retrievalScopeSchema } from '@chief/contracts/knowledge';
import { describe, expect, it, vi } from 'vitest';

import { DynamoS3RetrievalAuthority } from './aws-durable-retrieval.js';
import {
  chiefRetrievalV1,
  retrievalDynamoEntityPrefixV1,
  retrievalDynamoKeyV1,
  sha256Bytes,
  type DurableRetrievalHeadV1,
  type StagedRetrievalMutationV1,
} from './durable-retrieval.js';

const scope = retrievalScopeSchema.parse({
  derivation: 'server_grants',
  tenantId: 'tenant-aws-test',
  accountIds: ['account-aws-test'],
  brandIds: ['brand-aws-test'],
  authorizationEpoch: 2,
  scopeHash: createHash('sha256').update('aws-scope').digest('hex'),
  role: 'factual',
});

function stagedManifest(selectedScope = scope): StagedRetrievalMutationV1 {
  const bytes = new TextEncoder().encode('[{"staged":true}]');
  const contentHash = sha256Bytes(bytes);
  const createdAt = '2026-07-18T12:00:00.000Z';
  return {
    contractVersion: chiefRetrievalV1.contractVersion,
    kind: 'staged-mutation',
    scope: selectedScope,
    mutationId: contentHash,
    stagingOrdinal: `${createdAt}#${contentHash}`,
    changeCount: 1,
    byteLength: bytes.byteLength,
    object: immutableBlobRefSchema.parse({
      schemaVersion: '1',
      tenantId: selectedScope.tenantId,
      bucketRef: 'retrieval-test',
      objectKey: `retrieval-staged/${selectedScope.scopeHash}/${contentHash}`,
      objectVersion: contentHash,
      contentHash,
      byteLength: bytes.byteLength,
      mediaType: 'application/vnd.chief.retrieval-staged+json;version=1',
      encryptionKeyRef: 'test-key',
      retentionPolicyVersion: '1',
    }),
    createdAt,
  };
}

describe('AWS durable retrieval authority', () => {
  it('uses one secret-independent key contract and bounded Query enumeration', async () => {
    const manifest = stagedManifest();
    const send = vi.fn((command: unknown) => {
      if (command instanceof UpdateCommand) return Promise.resolve({});
      if (command instanceof PutCommand) return Promise.resolve({});
      if (command instanceof QueryCommand)
        return Promise.resolve({ Items: [{ manifest }] });
      return Promise.reject(new Error('unexpected Dynamo command'));
    });
    const authority = new DynamoS3RetrievalAuthority({
      client: { send } as unknown as DynamoDBDocumentClient,
      tableName: 'retrieval-table',
    });

    await authority.register(manifest);
    const page = await authority.listStaged({ scope, limit: 256 });

    const epochUpdate = send.mock.calls[0]?.[0];
    const put = send.mock.calls[1]?.[0];
    const query = send.mock.calls[2]?.[0];
    expect(epochUpdate).toBeInstanceOf(UpdateCommand);
    expect(put).toBeInstanceOf(PutCommand);
    expect(query).toBeInstanceOf(QueryCommand);
    expect((put as PutCommand).input.Item).toMatchObject(
      retrievalDynamoKeyV1(
        scope,
        `staged-${String(scope.authorizationEpoch)}:${manifest.mutationId}`,
      ),
    );
    expect((query as QueryCommand).input).toMatchObject({
      Limit: 256,
      ConsistentRead: true,
      ScanIndexForward: true,
      ExpressionAttributeValues: {
        ':pk': retrievalDynamoEntityPrefixV1(scope, 'staged-2').PK,
        ':prefix': retrievalDynamoEntityPrefixV1(scope, 'staged-2').SKPrefix,
      },
    });
    expect(page).toEqual({ manifests: [manifest] });
    expect(chiefRetrievalV1.keyContractVersion).toBe('chief-retrieval-key.v1');
    expect(
      retrievalDynamoKeyV1(
        retrievalScopeSchema.parse({
          ...scope,
          tenantId: 'tenant-other',
          scopeHash: sha256Bytes('other-scope'),
        }),
        `staged:${manifest.mutationId}`,
      ).PK,
    ).not.toBe(retrievalDynamoKeyV1(scope, `staged:${manifest.mutationId}`).PK);
  });

  it('rejects cross-tenant manifests returned by the scoped query', async () => {
    const foreignScope = retrievalScopeSchema.parse({
      ...scope,
      tenantId: 'tenant-other',
      scopeHash: sha256Bytes('foreign-scope'),
    });
    const authority = new DynamoS3RetrievalAuthority({
      client: {
        send: () =>
          Promise.resolve({
            Items: [{ manifest: stagedManifest(foreignScope) }],
          }),
      } as unknown as DynamoDBDocumentClient,
      tableName: 'retrieval-table',
    });
    await expect(
      authority.listStaged({ scope, limit: 256 }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('reads an independent epoch item and transactionally fences head promotion', async () => {
    const commands: unknown[] = [];
    const send = vi.fn((command: unknown) => {
      commands.push(command);
      if (command instanceof GetCommand)
        return Promise.resolve({
          Item: {
            tenantId: scope.tenantId,
            scopeHash: scope.scopeHash,
            role: scope.role,
            authorizationEpoch: scope.authorizationEpoch,
          },
        });
      if (command instanceof TransactWriteCommand) return Promise.resolve({});
      return Promise.reject(new Error('unexpected Dynamo command'));
    });
    const authority = new DynamoS3RetrievalAuthority({
      client: { send } as unknown as DynamoDBDocumentClient,
      tableName: 'retrieval-table',
    });
    await expect(authority.getAuthorizationEpoch(scope)).resolves.toBe(2);
    const object = stagedManifest().object;
    const head: DurableRetrievalHeadV1 = {
      contractVersion: chiefRetrievalV1.contractVersion,
      kind: 'snapshot-head',
      scope,
      generation: 1,
      publishedSequenceStart: 1,
      publishedSequenceEnd: 1,
      manifest: {
        schemaVersion: '1',
        tenantId: scope.tenantId,
        role: scope.role,
        scopeHash: scope.scopeHash,
        generation: 1,
        authorizationEpoch: scope.authorizationEpoch,
        sourceWatermark: 'watermark',
        embeddingProfileManifestHash: sha256Bytes('profile'),
        vectorDimension: 1,
        normalizationVersion: '1',
        lexicalScoringVersion: 'chief-bounded-fusion-v1',
        vectorFormat: 'binary32-le-row-major',
        shards: [
          {
            chunkIdObject: object,
            vectorObject: object,
            chunkCount: 1,
            decodedBytes: object.byteLength,
          },
        ],
        sourceCount: 1,
        chunkCount: 1,
        serializedBytes: object.byteLength,
        decodedBytes: object.byteLength,
        manifestHash: sha256Bytes('manifest'),
        createdAt: '2026-07-18T12:01:00.000Z',
      },
      promotedAt: '2026-07-18T12:01:00.000Z',
    };
    await expect(
      authority.compareAndSwapHead({ scope, next: head }),
    ).resolves.toBe('promoted');
    const epochRead = commands[0];
    const promotion = commands[1];
    expect(epochRead).toBeInstanceOf(GetCommand);
    expect((epochRead as GetCommand).input.Key).toEqual(
      retrievalDynamoKeyV1(scope, 'authorization-epoch'),
    );
    expect(promotion).toBeInstanceOf(TransactWriteCommand);
    expect(
      (promotion as TransactWriteCommand).input.TransactItems?.[0]
        ?.ConditionCheck?.Key,
    ).toEqual(retrievalDynamoKeyV1(scope, 'authorization-epoch'));
  });

  it('rejects a stale epoch advance', async () => {
    const authority = new DynamoS3RetrievalAuthority({
      client: {
        send: () => {
          const error = new Error('stale');
          error.name = 'ConditionalCheckFailedException';
          return Promise.reject(error);
        },
      } as unknown as DynamoDBDocumentClient,
      tableName: 'retrieval-table',
    });
    await expect(
      authority.advanceAuthorizationEpoch(scope),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});
