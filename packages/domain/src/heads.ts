import type {
  ActionRecommendation,
  DraftHead,
  DraftRevision,
  RecommendationHead,
  TenantId,
} from '@chief/contracts';

import {
  assertExpected,
  assertTenant,
  DomainInvariantError,
  immutable,
} from './invariants.js';

export function swapRecommendationHead(input: {
  readonly actorTenantId: TenantId;
  readonly current: RecommendationHead;
  readonly expectedHeadVersion: number;
  readonly next: ActionRecommendation;
  readonly updatedAt: string;
}): Readonly<RecommendationHead> {
  assertTenant(input.actorTenantId, input.current.tenantId);
  assertTenant(input.current.tenantId, input.next.tenantId);
  assertExpected(
    input.current.headVersion,
    input.expectedHeadVersion,
    'revision',
  );
  if (
    input.current.sourceMessageRevisionId !== input.next.sourceMessageRevisionId
  ) {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      'recommendation head cannot move to another source message revision',
    );
  }
  if (input.next.revision <= input.current.revision) {
    throw new DomainInvariantError(
      'STALE_REVISION',
      'recommendation revision must advance',
    );
  }
  return immutable({
    tenantId: input.current.tenantId,
    sourceMessageRevisionId: input.current.sourceMessageRevisionId,
    recommendationId: input.next.recommendationId,
    revision: input.next.revision,
    headVersion: input.current.headVersion + 1,
    updatedAt: input.updatedAt,
  });
}

export function swapDraftHead(input: {
  readonly actorTenantId: TenantId;
  readonly current: DraftHead;
  readonly expectedHeadVersion: number;
  readonly next: DraftRevision;
  readonly updatedAt: string;
}): Readonly<DraftHead> {
  assertTenant(input.actorTenantId, input.current.tenantId);
  assertTenant(input.current.tenantId, input.next.tenantId);
  assertExpected(
    input.current.headVersion,
    input.expectedHeadVersion,
    'revision',
  );
  if (
    input.current.draftId !== input.next.draftId ||
    input.next.revision !== input.current.revision + 1 ||
    input.next.supersedesRevisionId !== input.current.draftRevisionId
  ) {
    throw new DomainInvariantError(
      'STALE_REVISION',
      'draft head requires the immediate immutable successor',
    );
  }
  return immutable({
    tenantId: input.current.tenantId,
    draftId: input.current.draftId,
    draftRevisionId: input.next.draftRevisionId,
    revision: input.next.revision,
    headVersion: input.current.headVersion + 1,
    updatedAt: input.updatedAt,
  });
}
