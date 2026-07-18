import { describe, expect, it } from 'vitest';

import { canonicalRetrievalSourceAuthoritySchema } from './connectors.js';

describe('canonical retrieval source authority', () => {
  it('binds communication and Asana classes to canonical ingestion kinds', () => {
    expect(
      canonicalRetrievalSourceAuthoritySchema.parse({
        contractVersion: 'chief-source-authority.v1',
        verifiedBy: 'canonical_ingestion',
        sourceClass: 'communication',
        sourceKind: 'gmail',
        relationKind: 'canonical_thread',
        relationTopic: 'release_readiness',
      }),
    ).toMatchObject({
      sourceClass: 'communication',
      sourceKind: 'gmail',
      relationTopic: 'release_readiness',
    });
    expect(
      canonicalRetrievalSourceAuthoritySchema.parse({
        contractVersion: 'chief-source-authority.v1',
        verifiedBy: 'canonical_ingestion',
        sourceClass: 'asana',
        sourceKind: 'asana',
        relationKind: 'explicit_related_work',
      }),
    ).toMatchObject({ sourceClass: 'asana', sourceKind: 'asana' });
  });

  it('rejects an Asana source relabeled as communication regardless of its object ID', () => {
    expect(
      canonicalRetrievalSourceAuthoritySchema.safeParse({
        contractVersion: 'chief-source-authority.v1',
        verifiedBy: 'canonical_ingestion',
        sourceClass: 'communication',
        sourceKind: 'asana',
        relationKind: 'canonical_thread',
      }).success,
    ).toBe(false);
  });

  it('rejects arbitrary relation topics at the canonical authority boundary', () => {
    expect(
      canonicalRetrievalSourceAuthoritySchema.safeParse({
        contractVersion: 'chief-source-authority.v1',
        verifiedBy: 'canonical_ingestion',
        sourceClass: 'communication',
        sourceKind: 'gmail',
        relationKind: 'canonical_thread',
        relationTopic: 'launch_party',
      }).success,
    ).toBe(false);
  });
});
