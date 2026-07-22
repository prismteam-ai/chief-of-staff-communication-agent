import { describe, expect, it } from 'vitest';
import { assertCommunicationConnectorContract } from '@chief/connector-testkit';
import { tenantIdSchema } from '@chief/contracts/ids';

import { createMicrosoftGraphFixtureConnector } from './connector.js';
import { createMicrosoftGraphContractFixtures } from './provider-fixtures.js';

describe('Microsoft Graph CommunicationConnector contract', () => {
  it('passes the frozen provider-shaped connector contract suite', async () => {
    const fixtures = createMicrosoftGraphContractFixtures({
      selectedForEffectContract: true,
    });
    const connector = createMicrosoftGraphFixtureConnector({
      account: fixtures.account,
    });
    const report = await assertCommunicationConnectorContract(
      connector,
      fixtures,
    );
    expect(report.passed).toBe(true);
    expect(report.checks.every((check) => check.passed)).toBe(true);
  });

  it('keeps the provider branch unselected and non-live', () => {
    const fixtures = createMicrosoftGraphContractFixtures();
    expect(fixtures.snapshot.selectionState).toBe('unselected_candidate');
    expect(fixtures.snapshot.runtimeMode).toBe('disabled');
    expect(fixtures.descriptor.supportedRuntimeModes).not.toContain('live');
    expect(fixtures.descriptor.capabilities.deliveryFeedback).toBe(false);
    expect(fixtures.account.status).toBe('disabled');
    const connector = createMicrosoftGraphFixtureConnector({
      account: fixtures.account,
    });
    expect(connector.parseFeedbackEvent).toBeUndefined();
  });

  it('rejects cross-tenant account validation', async () => {
    const fixtures = createMicrosoftGraphContractFixtures();
    const connector = createMicrosoftGraphFixtureConnector({
      account: fixtures.account,
    });
    await expect(
      connector.validateConnection({
        ...fixtures.accountRef,
        tenantId: tenantIdSchema.parse('tenant-b'),
      }),
    ).rejects.toThrow('GRAPH_ACCOUNT_BINDING_MISMATCH');
  });
});
