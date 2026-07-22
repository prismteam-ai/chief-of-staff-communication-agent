import type { PollRequest, SyncPage } from '@chief/contracts/connectors';

export type { PollRequest, SyncPage };

export function assertCheckpointFence(request: PollRequest): void {
  if (
    request.checkpoint.accountId !== request.account.accountId ||
    request.checkpoint.tenantId !== request.account.tenantId ||
    request.checkpoint.resourceScopeHash !== request.resourceScopeHash ||
    request.checkpoint.checkpointEpoch !== request.expectedCheckpointEpoch ||
    request.checkpoint.adapterVersion !== request.adapterVersion ||
    request.maxItems <= 0 ||
    request.maxPages <= 0
  ) {
    throw new Error('CHECKPOINT_FENCE_REJECTED');
  }
}
