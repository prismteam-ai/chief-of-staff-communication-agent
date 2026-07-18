import {
  AsanaConnectorError,
  AsanaWorkManagementConnector,
  createAsanaWorkManagementConnector,
} from './connector.js';
import {
  AsanaRestTransport,
  type AsanaRestTransportOptions,
} from './transport.js';
import type { AsanaConnectorOptions } from './types.js';

export interface AsanaLiveCompositionInput extends Omit<
  AsanaConnectorOptions,
  'transport'
> {
  readonly transport: Omit<AsanaRestTransportOptions, 'fetch'>;
}

/**
 * Production composition. The API origin is intentionally not configurable;
 * callers inject only credential custody, connector authority/payload ports,
 * and optional stricter transport bounds/evidence collection. The live
 * composition always uses Node's built-in fetch implementation.
 */
export function createAsanaLiveComposition(input: AsanaLiveCompositionInput): {
  readonly transport: AsanaRestTransport;
  readonly connector: AsanaWorkManagementConnector;
} {
  assertLiveSnapshot(input);
  const transport = new AsanaRestTransport(liveTransportOptions(input));
  return Object.freeze({
    transport,
    connector: new AsanaWorkManagementConnector({
      clientId: input.clientId,
      scope: input.scope,
      currentSnapshot: input.currentSnapshot,
      transport,
      authorization: input.authorization,
      effectPayloads: input.effectPayloads,
      webhookVerificationKey: input.webhookVerificationKey,
      webhookTargetUrl: input.webhookTargetUrl,
      clock: input.clock,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
  });
}

export function createAsanaLiveWorkManagementConnector(
  input: AsanaLiveCompositionInput,
) {
  assertLiveSnapshot(input);
  const transport = new AsanaRestTransport(liveTransportOptions(input));
  return Object.freeze({
    transport,
    connector: createAsanaWorkManagementConnector({
      clientId: input.clientId,
      scope: input.scope,
      currentSnapshot: input.currentSnapshot,
      transport,
      authorization: input.authorization,
      effectPayloads: input.effectPayloads,
      webhookVerificationKey: input.webhookVerificationKey,
      webhookTargetUrl: input.webhookTargetUrl,
      clock: input.clock,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
  });
}

function liveTransportOptions(
  input: AsanaLiveCompositionInput,
): AsanaRestTransportOptions {
  const allowed = new Set([
    'credentials',
    'evidence',
    'deadlineMilliseconds',
    'maxResponseBytes',
    'maxRequestBytes',
  ]);
  if (
    'fetch' in input.transport ||
    Object.keys(input.transport).some((key) => !allowed.has(key))
  ) {
    throw new AsanaConnectorError(
      'ASANA_LIVE_COMPOSITION_TRANSPORT_AUTHORITY_REJECTED',
    );
  }
  return {
    credentials: input.transport.credentials,
    ...(input.transport.evidence === undefined
      ? {}
      : { evidence: input.transport.evidence }),
    ...(input.transport.deadlineMilliseconds === undefined
      ? {}
      : { deadlineMilliseconds: input.transport.deadlineMilliseconds }),
    ...(input.transport.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: input.transport.maxResponseBytes }),
    ...(input.transport.maxRequestBytes === undefined
      ? {}
      : { maxRequestBytes: input.transport.maxRequestBytes }),
  };
}

function assertLiveSnapshot(input: AsanaLiveCompositionInput): void {
  if (input.currentSnapshot.runtimeMode !== 'live') {
    throw new AsanaConnectorError(
      'ASANA_LIVE_COMPOSITION_REQUIRES_LIVE_SNAPSHOT',
    );
  }
}
