import type { CommunicationConnector } from '@chief/connector-core';

import { createDeterministicConnector } from './fakes.js';
import type { ConnectorContractFixtures } from './fixtures.js';

export function createDeliberatelyBrokenAdapter(
  fixtures: ConnectorContractFixtures,
): CommunicationConnector {
  return createDeterministicConnector(fixtures, {
    malformedNormalization: true,
    omitReconciliation: true,
  }).connector;
}
