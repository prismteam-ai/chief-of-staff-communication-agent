import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  deterministicEvaluatorIdentityV1,
  deterministicEvaluatorIdentityV2,
  immutableBlobRefSchema,
  type ImmutableBlobRef,
} from '@chief/contracts';
import {
  retrievalQuerySchema,
  type RetrievalScope,
} from '@chief/contracts/knowledge';
import {
  BoundedDynamoS3RetrievalIndex,
  BoundedRetrievalError,
  DeterministicEffectDisabledEmbedding,
  DurableRetrievalCompactor,
  canonicalJson,
  createBoundedSnapshotValidator,
  parseStagedMutationObject,
  prepareEffectDisabledQueryVector,
  sha256Bytes,
  validateStagedRetrievalMutation,
  type DurableRetrievalHeadV1,
  type ImmutableRetrievalArtifactStore,
  type StagedRetrievalMutationV1,
} from '@chief/rag';
import { describe, expect, it } from 'vitest';

import { CompactingRetrievalRegistrar } from '../aws-composition.js';
import {
  createEvaluatorSeedMemoryProbe,
  evaluatorSeedMemoryLimitBytes,
  parseSeedCliConfig,
} from './cli.js';
import {
  evaluatorRetrievalScope,
  seedEvaluatorRetrieval,
  type EvaluatorRetrievalSeedDependencies,
} from './retrieval-seed.js';

class TestArtifactStore implements ImmutableRetrievalArtifactStore {
  readonly objects = new Map<string, Uint8Array>();
  public bindingMismatchReads = 0;

  public constructor(
    public readonly bucketRef = 'deterministic-evaluator-seed-test',
  ) {}

  public putImmutableObject(input: {
    readonly tenantId: string;
    readonly scopeHash: string;
    readonly namespace: 'retrieval-staged' | 'retrieval-snapshots';
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<ImmutableBlobRef> {
    const contentHash = sha256Bytes(input.bytes);
    const objectKey = `${input.namespace}/${input.scopeHash}/${contentHash}`;
    this.objects.set(objectKey, new Uint8Array(input.bytes));
    return Promise.resolve(
      immutableBlobRefSchema.parse({
        schemaVersion: '1',
        tenantId: input.tenantId,
        bucketRef: this.bucketRef,
        objectKey,
        objectVersion: contentHash,
        contentHash,
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType,
        encryptionKeyRef: 'deterministic-evaluator-seed-test',
        retentionPolicyVersion: '1',
      }),
    );
  }

  public getImmutableObject(ref: ImmutableBlobRef): Promise<Uint8Array> {
    if (ref.bucketRef !== this.bucketRef) {
      this.bindingMismatchReads += 1;
      return Promise.reject(new BoundedRetrievalError('CORRUPT_SNAPSHOT'));
    }
    const bytes = this.objects.get(ref.objectKey);
    if (bytes === undefined) return Promise.reject(new Error('missing object'));
    return Promise.resolve(new Uint8Array(bytes));
  }
}

class TestAuthority {
  public epoch: number | undefined;
  public head: DurableRetrievalHeadV1 | undefined;
  readonly staged = new Map<string, StagedRetrievalMutationV1>();

  public getHead(
    _scope: RetrievalScope,
  ): Promise<DurableRetrievalHeadV1 | undefined> {
    return Promise.resolve(this.head);
  }

  public compareAndSwapHead(input: {
    readonly scope: RetrievalScope;
    readonly expectedManifestHash?: string;
    readonly next: DurableRetrievalHeadV1;
  }): Promise<'promoted' | 'stale'> {
    if (
      this.epoch !== input.scope.authorizationEpoch ||
      this.head?.manifest.manifestHash !== input.expectedManifestHash
    )
      return Promise.resolve('stale');
    this.head = input.next;
    return Promise.resolve('promoted');
  }

  public register(candidate: StagedRetrievalMutationV1): Promise<void> {
    const manifest = validateStagedRetrievalMutation(candidate);
    if (
      canonicalJson(manifest.scope) !== canonicalJson(evaluatorRetrievalScope)
    )
      throw new BoundedRetrievalError('ACCESS_DENIED');
    if (this.epoch === undefined)
      this.epoch = manifest.scope.authorizationEpoch;
    if (this.epoch !== manifest.scope.authorizationEpoch)
      throw new BoundedRetrievalError('ACCESS_DENIED');
    const prior = this.staged.get(manifest.mutationId);
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(manifest))
      throw new BoundedRetrievalError('INDEX_REFRESH_REQUIRED');
    this.staged.set(manifest.mutationId, manifest);
    return Promise.resolve();
  }

  public listStaged(input: {
    readonly scope: RetrievalScope;
    readonly limit: number;
    readonly nextToken?: string;
  }): Promise<{
    readonly manifests: readonly StagedRetrievalMutationV1[];
    readonly nextToken?: string;
  }> {
    if (canonicalJson(input.scope) !== canonicalJson(evaluatorRetrievalScope))
      throw new BoundedRetrievalError('ACCESS_DENIED');
    const manifests = [...this.staged.values()]
      .sort((left, right) => left.mutationId.localeCompare(right.mutationId))
      .filter(
        ({ mutationId }) =>
          input.nextToken === undefined || mutationId > input.nextToken,
      )
      .slice(0, input.limit);
    const hasMore =
      manifests.length === input.limit &&
      manifests.at(-1)?.mutationId !== [...this.staged.keys()].sort().at(-1);
    return Promise.resolve({
      manifests,
      ...(hasMore && manifests.at(-1) !== undefined
        ? { nextToken: manifests.at(-1)?.mutationId }
        : {}),
    });
  }
}

function fixture() {
  const artifacts = new TestArtifactStore();
  const authority = new TestAuthority();
  return {
    artifacts,
    authority,
    dependencies: {
      artifacts,
      authority,
      readAuthorizationEpoch: () => Promise.resolve(authority.epoch),
      memory: {
        sample: () => ({ rssBytes: 1, limitBytes: 10_000_000_000 }),
      },
    },
  };
}

function authorityState(authority: TestAuthority) {
  return {
    epoch: authority.epoch,
    generation: authority.head?.generation,
    head: canonicalJson(authority.head),
    catalog: canonicalJson(
      [...authority.staged.values()].sort((left, right) =>
        left.mutationId.localeCompare(right.mutationId),
      ),
    ),
  };
}

function artifactState(artifacts: TestArtifactStore) {
  return [...artifacts.objects.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, bytes]) => ({ key, hash: sha256Bytes(bytes) }));
}

function compactorFor(
  authority: TestAuthority,
  artifacts: TestArtifactStore,
  memory: EvaluatorRetrievalSeedDependencies['memory'],
) {
  const producer = new DeterministicEffectDisabledEmbedding();
  return new CompactingRetrievalRegistrar(
    authority,
    new DurableRetrievalCompactor({
      artifacts,
      heads: authority,
      memory,
      embeddingProfileManifestHash: producer.profileManifestHash,
      embeddingProfileId: producer.profileId,
      vectorDimension: producer.dimension,
      now: () => new Date('2026-07-17T12:00:00.000Z'),
    }),
  );
}

async function stagedDocuments(
  authority: TestAuthority,
  artifacts: TestArtifactStore,
) {
  const producer = new DeterministicEffectDisabledEmbedding();
  return Promise.all(
    [...authority.staged.values()].map(async (manifest) =>
      parseStagedMutationObject(
        await artifacts.getImmutableObject(manifest.object),
        manifest.stagingOrdinal,
        producer.dimension,
      ),
    ),
  );
}

async function rogueManifest(
  authority: TestAuthority,
  artifacts: TestArtifactStore,
): Promise<StagedRetrievalMutationV1> {
  const source = [...authority.staged.values()][0] as StagedRetrievalMutationV1;
  const [document] = JSON.parse(
    new TextDecoder().decode(await artifacts.getImmutableObject(source.object)),
  ) as [{ record: Record<string, unknown> } & Record<string, unknown>];
  const rogueDocument = {
    ...document,
    record: {
      ...document.record,
      chunkId: 'rogue-evaluator-chunk',
      sourceId: 'rogue-evaluator-source',
      exactEntityRefs: ['rogue-evaluator-entity'],
    },
  };
  const bytes = new TextEncoder().encode(canonicalJson([rogueDocument]));
  const object = await artifacts.putImmutableObject({
    tenantId: evaluatorRetrievalScope.tenantId,
    scopeHash: evaluatorRetrievalScope.scopeHash,
    namespace: 'retrieval-staged',
    bytes,
    mediaType: source.object.mediaType,
  });
  return validateStagedRetrievalMutation({
    ...source,
    mutationId: sha256Bytes(bytes),
    byteLength: bytes.byteLength,
    object,
  });
}

describe('deterministic evaluator retrieval seed', () => {
  it('builds the ingestion worker and every workspace dependency before execution', () => {
    const workspaceRoot = resolve(import.meta.dirname, '../../../..');
    const rootPackage = JSON.parse(
      readFileSync(resolve(workspaceRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const workerPackage = JSON.parse(
      readFileSync(
        resolve(workspaceRoot, 'apps/ingestion-worker/package.json'),
        'utf8',
      ),
    ) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(rootPackage.scripts['seed:evaluator-retrieval']).toContain(
      'turbo run build --filter=@chief/ingestion-worker',
    );
    expect(workerPackage.scripts['seed:evaluator-retrieval']).toContain(
      'turbo run build --filter=@chief/ingestion-worker',
    );
    const turbo = JSON.parse(
      readFileSync(resolve(workspaceRoot, 'turbo.json'), 'utf8'),
    ) as { tasks: { build: { dependsOn: string[] } } };
    expect(turbo.tasks.build.dependsOn).toContain('^build');
    expect(workerPackage.scripts.test).toContain(
      'turbo run build --filter=@chief/ingestion-worker^...',
    );
    expect(
      Object.keys(workerPackage.dependencies).filter((name) =>
        name.startsWith('@chief/'),
      ),
    ).not.toHaveLength(0);
  });

  it('loads generic AWS bindings from environment or explicit CLI overrides', () => {
    expect(
      parseSeedCliConfig([], {
        RETRIEVAL_TABLE_NAME: 'retrieval-from-env',
        SNAPSHOT_BUCKET_NAME: 'bucket-from-env',
        PRODUCT_DATA_KEY_ARN: 'key-from-env',
      }),
    ).toEqual({
      tableName: 'retrieval-from-env',
      bucketName: 'bucket-from-env',
      kmsKeyArn: 'key-from-env',
      region: 'us-east-2',
    });
    expect(
      parseSeedCliConfig(
        [
          '--table-name',
          'retrieval-from-cli',
          '--bucket-name',
          'bucket-from-cli',
          '--kms-key-arn',
          'key-from-cli',
          '--region',
          'us-east-1',
        ],
        {},
      ),
    ).toEqual({
      tableName: 'retrieval-from-cli',
      bucketName: 'bucket-from-cli',
      kmsKeyArn: 'key-from-cli',
      region: 'us-east-1',
    });
  });

  it('rejects incomplete, unknown, and duplicate CLI bindings', () => {
    expect(() => parseSeedCliConfig([], {})).toThrow(
      'SEED_RETRIEVAL_TABLE_REQUIRED',
    );
    expect(() => parseSeedCliConfig(['--unknown', 'value'], {})).toThrow(
      'SEED_ARGUMENT_INVALID',
    );
    expect(() =>
      parseSeedCliConfig(['--table-name', 'one', '--table-name', 'two'], {}),
    ).toThrow('SEED_ARGUMENT_DUPLICATE');
  });

  it('uses the deployment-equivalent 512 MiB bound and rejects at that bound', async () => {
    expect(evaluatorSeedMemoryLimitBytes).toBe(512 * 1024 * 1024);
    expect(createEvaluatorSeedMemoryProbe(() => 123).sample()).toEqual({
      rssBytes: 123,
      limitBytes: 512 * 1024 * 1024,
    });
    const { dependencies, authority, artifacts } = fixture();
    dependencies.memory = createEvaluatorSeedMemoryProbe(
      () => evaluatorSeedMemoryLimitBytes,
    );

    await expect(seedEvaluatorRetrieval(dependencies)).rejects.toMatchObject({
      code: 'SEED_MEMORY_LIMIT',
    });
    expect(authority.staged.size).toBe(0);
    expect(artifacts.objects.size).toBe(0);
  });

  it('promotes the exact owner-free multi-channel V2 corpus on a fresh runtime', async () => {
    const { dependencies, authority } = fixture();

    const result = await seedEvaluatorRetrieval(dependencies);

    expect(result).toEqual({
      schemaVersion: '1',
      seedVersion: 'chief-evaluator-retrieval-seed.v2',
      seedId:
        'e6755bf3f2cd96a4b4af9c395e6a9a89775f311c0a14680e9ac700ce31e96af3',
      status: 'seeded',
      scopeHash:
        '78f117a88b1fc73ce8c394e2045888eb102fd34ee3e8c77fbaa75cb21d9a8e3d',
      authorizationEpoch: 1,
      manifestHash:
        '9b2e0f7339885bbb74af029583b2e95b2dcfa23ae6d1dae557da335953e011fe',
      generation: 1,
      chunkCount: 1_120,
      sourceCount: 1_120,
      threadCount: 160,
      accountCount: 7,
      brandCount: 2,
      channelCounts: {
        gmail: 161,
        microsoft_graph: 161,
        sms: 161,
        whatsapp: 161,
        x: 161,
        linkedin_archive: 161,
        future_demo: 154,
      },
      brandCounts: {
        'brand-northstar': 637,
        'brand-harbor': 483,
      },
    });
    expect(authority.epoch).toBe(1);
    expect(authority.staged.size).toBe(1_120);
    expect(deterministicEvaluatorIdentityV1.connector.runtimeMode).toBe(
      'fixture',
    );
    const documents = await stagedDocuments(authority, dependencies.artifacts);
    expect(documents).toHaveLength(1_120);
    expect(
      deterministicEvaluatorIdentityV2.anchorOverlays.map((anchor) => {
        const document = documents.find(
          ({ record }) =>
            record.exactEntityRefs.includes(anchor.retrievalExactEntityRef) &&
            record.sourceAuthority?.sourceClass === 'communication' &&
            record.sourceAuthority.relationTopic !== undefined,
        );
        return {
          chunkId: document?.record.chunkId,
          sourceId: document?.record.sourceId,
          sourceVersion: document?.record.sourceVersion,
          exactEntityRefs: document?.record.exactEntityRefs,
          sourceAuthority: document?.record.sourceAuthority,
        };
      }),
    ).toEqual([
      {
        chunkId:
          'h1_deterministic_evaluator_seed_v1_JGYh0xduVhg2BiF1PyZrcgLcyji29sijg1ilMuD-qFY:3ec5dd5bdc24a0edef761555d9100bc853213236ec37ed74a80923f287fcc4cc',
        sourceId:
          'h1_deterministic_evaluator_seed_v1_JGYh0xduVhg2BiF1PyZrcgLcyji29sijg1ilMuD-qFY:3ec5dd5bdc24a0edef761555d9100bc853213236ec37ed74a80923f287fcc4cc',
        sourceVersion:
          '3ec5dd5bdc24a0edef761555d9100bc853213236ec37ed74a80923f287fcc4cc',
        exactEntityRefs: ['thr_94f02c2953e5253d7f62f514efffdda78aa29090'],
        sourceAuthority: {
          contractVersion: 'chief-source-authority.v1',
          verifiedBy: 'canonical_ingestion',
          sourceClass: 'communication',
          sourceKind: 'gmail',
          relationKind: 'canonical_thread',
          relationTopic: 'release_readiness',
        },
      },
      {
        chunkId:
          'h1_deterministic_evaluator_seed_v1_w-jMP3I_f0X_I-PR_WVXU58yeXq51BLW4zCS9JqKKSg:49ee3e715f21ab40d361d2aa06f9871cb1bf5cb3731beb9d212f9944e02fb7d0',
        sourceId:
          'h1_deterministic_evaluator_seed_v1_w-jMP3I_f0X_I-PR_WVXU58yeXq51BLW4zCS9JqKKSg:49ee3e715f21ab40d361d2aa06f9871cb1bf5cb3731beb9d212f9944e02fb7d0',
        sourceVersion:
          '49ee3e715f21ab40d361d2aa06f9871cb1bf5cb3731beb9d212f9944e02fb7d0',
        exactEntityRefs: ['thr_309a81cf66fffd346b95eccaf016494a30abd88f'],
        sourceAuthority: {
          contractVersion: 'chief-source-authority.v1',
          verifiedBy: 'canonical_ingestion',
          sourceClass: 'communication',
          sourceKind: 'gmail',
          relationKind: 'canonical_thread',
          relationTopic: 'board_metrics',
        },
      },
    ]);
  }, 30_000);

  it('reruns idempotently without advancing the promoted head', async () => {
    const { dependencies } = fixture();
    const first = await seedEvaluatorRetrieval(dependencies);

    const second = await seedEvaluatorRetrieval(dependencies);

    expect(second).toEqual({ ...first, status: 'already_current' });
  }, 15_000);

  it('recovers an exact partial catalog and preserves deterministic identity', async () => {
    const { dependencies, authority } = fixture();
    const completed = await seedEvaluatorRetrieval(dependencies);
    const firstManifest = [...authority.staged.values()][0];
    authority.head = undefined;
    authority.staged.clear();
    authority.staged.set(
      (firstManifest as StagedRetrievalMutationV1).mutationId,
      firstManifest as StagedRetrievalMutationV1,
    );

    const recovered = await seedEvaluatorRetrieval(dependencies);

    expect(recovered).toEqual({ ...completed, status: 'seeded' });
    expect(authority.staged.size).toBe(1_120);
  }, 30_000);

  it('recovers a valid partial promoted head to the exact readable idempotent authority', async () => {
    const { dependencies, authority, artifacts } = fixture();
    const completed = await seedEvaluatorRetrieval(dependencies);
    const firstManifest = [...authority.staged.values()][0];
    expect(firstManifest).toBeDefined();
    if (firstManifest === undefined) throw new Error('missing first manifest');

    authority.head = undefined;
    authority.staged.clear();
    await compactorFor(authority, artifacts, dependencies.memory).register(
      firstManifest,
    );
    expect(authorityState(authority)).toMatchObject({
      epoch: 1,
      generation: 1,
    });
    const partialHead = await authority.getHead(evaluatorRetrievalScope);
    expect(partialHead?.manifest).toMatchObject({
      chunkCount: 1,
      sourceCount: 1,
    });
    expect(authority.staged.size).toBe(1);

    const recovered = await seedEvaluatorRetrieval(dependencies);

    expect(recovered).toMatchObject({
      seedId: completed.seedId,
      status: 'seeded',
      generation: 2,
      chunkCount: 1_120,
      sourceCount: 1_120,
    });
    expect(recovered.manifestHash).not.toBe(completed.manifestHash);
    expect(authority.epoch).toBe(1);
    expect(authority.staged.size).toBe(1_120);
    const recoveredHead = await authority.getHead(evaluatorRetrievalScope);
    expect(recoveredHead).toBeDefined();
    if (recoveredHead === undefined) throw new Error('missing recovered head');
    await expect(
      createBoundedSnapshotValidator({
        artifacts,
        memory: dependencies.memory,
      })(evaluatorRetrievalScope, recoveredHead.manifest),
    ).resolves.toBeUndefined();
    const exactRecoveredAuthority = authorityState(authority);

    await expect(seedEvaluatorRetrieval(dependencies)).resolves.toEqual({
      ...recovered,
      status: 'already_current',
    });
    expect(authorityState(authority)).toEqual(exactRecoveredAuthority);
  }, 30_000);

  it('rejects an extra catalog record before changing the head', async () => {
    const { dependencies, authority, artifacts } = fixture();
    await seedEvaluatorRetrieval(dependencies);
    const originalHead = authority.head;
    const rogue = await rogueManifest(authority, artifacts);
    authority.staged.set(rogue.mutationId, rogue);

    await expect(seedEvaluatorRetrieval(dependencies)).rejects.toMatchObject({
      code: 'SEED_CATALOG_DRIFT',
    });
    expect(authority.head).toBe(originalHead);
  }, 30_000);

  it('rejects an otherwise valid head containing an extra record', async () => {
    const { dependencies, authority, artifacts } = fixture();
    await seedEvaluatorRetrieval(dependencies);
    const rogue = await rogueManifest(authority, artifacts);
    await compactorFor(authority, artifacts, dependencies.memory).register(
      rogue,
    );
    const extraHead = authority.head;

    await expect(seedEvaluatorRetrieval(dependencies)).rejects.toMatchObject({
      code: 'SEED_SNAPSHOT_DRIFT',
    });
    expect(authority.head).toBe(extraHead);
    expect(authority.head?.manifest.chunkCount).toBe(1_121);
  }, 30_000);

  it('rejects corrupt staged and promoted vector objects', async () => {
    const stagedFixture = fixture();
    await seedEvaluatorRetrieval(stagedFixture.dependencies);
    const stagedManifest = [
      ...stagedFixture.authority.staged.values(),
    ][0] as StagedRetrievalMutationV1;
    stagedFixture.artifacts.objects.set(
      stagedManifest.object.objectKey,
      new TextEncoder().encode('{'),
    );
    const stagedAuthorityBefore = authorityState(stagedFixture.authority);
    const stagedArtifactsBefore = artifactState(stagedFixture.artifacts);
    await expect(
      seedEvaluatorRetrieval(stagedFixture.dependencies),
    ).rejects.toBeInstanceOf(BoundedRetrievalError);
    expect(authorityState(stagedFixture.authority)).toEqual(
      stagedAuthorityBefore,
    );
    expect(artifactState(stagedFixture.artifacts)).toEqual(
      stagedArtifactsBefore,
    );

    const vectorFixture = fixture();
    await seedEvaluatorRetrieval(vectorFixture.dependencies);
    const vectorObject = vectorFixture.authority.head?.manifest.shards[0]
      ?.vectorObject as ImmutableBlobRef;
    const vectorBytes = new Uint8Array(
      vectorFixture.artifacts.objects.get(vectorObject.objectKey) as Uint8Array,
    );
    vectorBytes[0] = (vectorBytes[0] ?? 0) ^ 0xff;
    vectorFixture.artifacts.objects.set(vectorObject.objectKey, vectorBytes);
    const vectorAuthorityBefore = authorityState(vectorFixture.authority);
    const vectorArtifactsBefore = artifactState(vectorFixture.artifacts);
    await expect(
      seedEvaluatorRetrieval(vectorFixture.dependencies),
    ).rejects.toBeInstanceOf(BoundedRetrievalError);
    expect(authorityState(vectorFixture.authority)).toEqual(
      vectorAuthorityBefore,
    );
    expect(artifactState(vectorFixture.artifacts)).toEqual(
      vectorArtifactsBefore,
    );
  }, 30_000);

  it('rejects the artifact bucket binding before object lookup without changing authority', async () => {
    const { dependencies, authority } = fixture();
    await seedEvaluatorRetrieval(dependencies);
    const authorityBefore = authorityState(authority);
    const mismatchedArtifacts = new TestArtifactStore(
      'different-snapshot-bucket',
    );

    const mismatched = seedEvaluatorRetrieval({
      ...dependencies,
      artifacts: mismatchedArtifacts,
    });
    await expect(mismatched).rejects.toMatchObject({
      code: 'CORRUPT_SNAPSHOT',
      message: 'CORRUPT_SNAPSHOT',
    });
    expect(mismatchedArtifacts.bindingMismatchReads).toBeGreaterThan(0);
    expect(mismatchedArtifacts.objects.size).toBe(0);
    expect(authorityState(authority)).toEqual(authorityBefore);
  }, 30_000);

  it('rejects a stale authorization epoch before staging data', async () => {
    const { dependencies, authority, artifacts } = fixture();
    authority.epoch = 2;

    await expect(seedEvaluatorRetrieval(dependencies)).rejects.toMatchObject({
      code: 'SEED_AUTHORIZATION_EPOCH_DRIFT',
    });
    expect(authority.staged.size).toBe(0);
    expect(artifacts.objects.size).toBe(0);
  });

  it('rejects a mixed-scope head instead of rewriting it', async () => {
    const { dependencies, authority } = fixture();
    await seedEvaluatorRetrieval(dependencies);
    const original = authority.head as DurableRetrievalHeadV1;
    authority.head = {
      ...original,
      scope: {
        ...original.scope,
        scopeHash: 'f'.repeat(64),
      },
    };

    await expect(seedEvaluatorRetrieval(dependencies)).rejects.toMatchObject({
      code: 'SEED_HEAD_SCOPE_DRIFT',
    });
    expect(authority.head).toEqual({
      ...original,
      scope: { ...original.scope, scopeHash: 'f'.repeat(64) },
    });
  }, 30_000);

  it('leaves a readable promoted head with real bounded citations', async () => {
    const { dependencies, authority, artifacts } = fixture();
    await seedEvaluatorRetrieval(dependencies);
    const producer = new DeterministicEffectDisabledEmbedding();
    const retrievalIndex = new BoundedDynamoS3RetrievalIndex({
      objects: artifacts,
      memory: dependencies.memory,
      authority: {
        getSnapshotHead: () => Promise.resolve(authority.head?.manifest),
        getAuthorizationEpoch: () => Promise.resolve(authority.epoch as number),
        queryDeltas: () => Promise.resolve({ manifests: [] }),
        getExactChunkIds: () => Promise.resolve([]),
        hydrateAuthorization: () => Promise.resolve([]),
        getQueryVector: () => Promise.reject(new Error('not required')),
      },
    });
    const documents = await stagedDocuments(authority, artifacts);
    for (const [communicationIndex, queryText] of [
      'Friday launch decision QA owner',
      'Board update approved pipeline numbers',
    ].entries()) {
      const identity =
        deterministicEvaluatorIdentityV2.anchorOverlays[communicationIndex];
      const exactDocument = documents.find(
        ({ record }) =>
          record.exactEntityRefs.includes(
            identity?.retrievalExactEntityRef ?? 'missing',
          ) &&
          record.sourceAuthority?.sourceClass === 'communication' &&
          record.sourceAuthority.relationTopic !== undefined,
      );
      expect(exactDocument).toBeDefined();
      const prepared = prepareEffectDisabledQueryVector({
        producer,
        queryText,
      });
      const query = (exactEntityRefs: readonly string[]) =>
        retrievalIndex.queryWithCitations(
          retrievalQuerySchema.parse({
            schemaVersion: '1',
            scope: evaluatorRetrievalScope,
            queryText,
            exactEntityRefs,
            limit: 2,
            embeddingProfileManifestHash: prepared.embeddingProfileManifestHash,
            queryHash: prepared.queryHash,
          }),
          prepared,
        );
      const baseline = await query([]);
      const result = await query([identity?.retrievalExactEntityRef as string]);
      expect(result.abstained).toBe(false);
      expect(
        result.citations.some(
          ({ chunkId, label }) =>
            chunkId === exactDocument?.record.chunkId &&
            label === 'gmail communication evidence',
        ),
      ).toBe(true);
      expect(result.snapshotManifestHash).toBe(
        authority.head?.manifest.manifestHash,
      );
      const exactCandidate = result.candidates.find(
        ({ chunkId }) => chunkId === exactDocument?.record.chunkId,
      );
      const baselineCandidate = baseline.candidates.find(
        ({ chunkId }) => chunkId === exactDocument?.record.chunkId,
      );
      expect(exactCandidate).toBeDefined();
      if (baselineCandidate !== undefined)
        expect(
          (exactCandidate?.fusedScore as number) - baselineCandidate.fusedScore,
        ).toBeCloseTo(0.15, 6);
    }
  });
});
