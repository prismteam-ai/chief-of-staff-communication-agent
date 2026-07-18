import { describe, expect, it } from 'vitest';
import { PersistenceConflictError } from '@chief/persistence-dynamodb';

import { MemoryDurableProductRepository } from './durable-product-repository.js';

describe('MemoryDurableProductRepository replay contract', () => {
  it('accepts only an exact immutable revision replay', async () => {
    const repository = new MemoryDurableProductRepository();
    const write = {
      entityType: 'draft',
      entityId: 'draft-1',
      revisionId: 'draft-revision-1',
      version: 1,
      committedAt: '2026-07-18T08:00:00.000Z',
      value: { body: 'Persisted body', revision: 1 },
    };

    await expect(repository.putRevision('tenant-1', write)).resolves.toBe(
      'created',
    );
    await expect(repository.putRevision('tenant-1', write)).resolves.toBe(
      'duplicate',
    );
    await expect(
      Promise.resolve().then(() =>
        repository.putRevision('tenant-1', {
          ...write,
          value: { body: 'Conflicting body', revision: 1 },
        }),
      ),
    ).rejects.toBeInstanceOf(PersistenceConflictError);
    await expect(
      repository.getCurrent('tenant-1', 'draft', 'draft-1'),
    ).resolves.toMatchObject({ value: write.value });
  });

  it('atomically advances a head with its exact immutable lookup', async () => {
    const repository = new MemoryDurableProductRepository();
    const input = {
      revision: {
        entityType: 'draft',
        entityId: 'draft-1',
        revisionId: 'draft-revision-1',
        version: 1,
        committedAt: '2026-07-18T08:00:00.000Z',
        value: { body: 'Persisted body', revision: 1 },
      },
      exactLookup: {
        entityType: 'draft-revision',
        entityId: 'draft-revision-1',
        revisionId: 'draft-revision-1',
        version: 1,
        committedAt: '2026-07-18T08:00:00.000Z',
        value: { body: 'Persisted body', revision: 1 },
      },
    };

    await expect(
      repository.putRevisionWithExactLookup('tenant-1', input),
    ).resolves.toBe('created');
    await expect(
      repository.putRevisionWithExactLookup('tenant-1', input),
    ).resolves.toBe('duplicate');
    await expect(
      repository.getExact('tenant-1', 'draft-revision', 'draft-revision-1'),
    ).resolves.toEqual(input.exactLookup);
    await expect(
      Promise.resolve().then(() =>
        repository.putRevisionWithExactLookup('tenant-1', {
          ...input,
          exactLookup: {
            ...input.exactLookup,
            value: { body: 'Conflicting body', revision: 1 },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(PersistenceConflictError);
    await expect(
      repository.getCurrent('tenant-1', 'draft', 'draft-1'),
    ).resolves.toMatchObject({ value: input.revision.value });
  });
});
