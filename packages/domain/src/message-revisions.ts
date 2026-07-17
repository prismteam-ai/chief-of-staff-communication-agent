import type { MessageRevision, TenantId } from '@chief/contracts';

import {
  assertExpected,
  assertTenant,
  DomainInvariantError,
  immutable,
} from './invariants.js';

export function appendMessageRevision(input: {
  readonly actorTenantId: TenantId;
  readonly current: MessageRevision;
  readonly expectedRevision: number;
  readonly next: MessageRevision;
}): Readonly<MessageRevision> {
  assertTenant(input.actorTenantId, input.current.tenantId);
  assertTenant(input.current.tenantId, input.next.tenantId);
  assertExpected(input.current.revision, input.expectedRevision, 'revision');
  if (
    input.current.messageId !== input.next.messageId ||
    input.current.threadId !== input.next.threadId
  ) {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      'message identity and thread are immutable across revisions',
    );
  }
  if (
    input.next.revision !== input.current.revision + 1 ||
    input.next.supersedesRevisionId !== input.current.revisionId
  ) {
    throw new DomainInvariantError(
      'STALE_REVISION',
      'new message revision must immediately supersede the current revision',
    );
  }
  if (input.next.contentHash === input.current.contentHash) {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      'an identical message body does not create a new revision',
    );
  }
  return immutable({ ...input.next });
}
