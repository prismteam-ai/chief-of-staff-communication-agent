import type { TransportState } from '@chief/contracts/approval';

import type { TwilioRawMessageStatus } from './normalization.js';

const rank: Readonly<Record<TransportState, number>> = {
  queued: 0,
  provider_rejected: 4,
  provider_accepted: 1,
  delivery_failed: 2,
  delivered: 3,
  bounced: 3,
  acceptance_unknown: 4,
};

export function canonicalTwilioTransportState(
  rawStatus: TwilioRawMessageStatus,
): TransportState {
  switch (rawStatus) {
    case 'accepted':
    case 'scheduled':
    case 'queued':
    case 'receiving':
      return 'queued';
    case 'sending':
    case 'sent':
    case 'received':
      return 'provider_accepted';
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'failed':
    case 'undelivered':
      return 'delivery_failed';
    case 'canceled':
      return 'provider_rejected';
  }
}

export interface TwilioStatusReduction {
  readonly state: TransportState;
  readonly changed: boolean;
  readonly rawStatus: TwilioRawMessageStatus;
  readonly reason:
    'duplicate' | 'advanced' | 'out_of_order_ignored' | 'terminal_preserved';
}

export function reduceTwilioStatus(
  current: TransportState | undefined,
  rawStatus: TwilioRawMessageStatus,
): TwilioStatusReduction {
  const next = canonicalTwilioTransportState(rawStatus);
  if (current === undefined) {
    return { state: next, changed: true, rawStatus, reason: 'advanced' };
  }
  if (current === next) {
    return { state: current, changed: false, rawStatus, reason: 'duplicate' };
  }
  if (current === 'provider_rejected' || current === 'acceptance_unknown') {
    return {
      state: current,
      changed: false,
      rawStatus,
      reason: 'terminal_preserved',
    };
  }
  if (rank[next] < rank[current]) {
    return {
      state: current,
      changed: false,
      rawStatus,
      reason: 'out_of_order_ignored',
    };
  }
  return { state: next, changed: true, rawStatus, reason: 'advanced' };
}
