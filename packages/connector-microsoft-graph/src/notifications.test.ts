import { describe, expect, it } from 'vitest';
import { rawWebhookRequestSchema } from '@chief/contracts/connectors';

import { inspectGraphNotificationRequest } from './notifications.js';
import {
  GRAPH_FIXTURE_CLIENT_STATE,
  GRAPH_FIXTURE_NOW,
  graphLifecycleFixture,
  graphNotificationBodyBase64,
} from './recorded-fixtures.js';

function request(rawBodyBase64: string, query = '') {
  return rawWebhookRequestSchema.parse({
    method: 'POST',
    providerVisibleUrl: `https://example.invalid/webhooks/graph${query}`,
    headers: { 'content-type': 'application/json' },
    rawBodyBase64,
    receivedAt: GRAPH_FIXTURE_NOW,
  });
}

describe('Microsoft Graph recorded notification lifecycle', () => {
  it('echoes the validation challenge as exact plain text without creating a subscription', () => {
    const result = inspectGraphNotificationRequest(
      request('e30=', '?validationToken=challenge%20bytes'),
      GRAPH_FIXTURE_CLIENT_STATE,
    );
    expect(result).toEqual({
      kind: 'validation_challenge',
      status: 200,
      contentType: 'text/plain',
      body: 'challenge bytes',
    });
  });

  it('rejects clientState mismatch before producing notification facts', () => {
    const result = inspectGraphNotificationRequest(
      request(
        graphNotificationBodyBase64({
          value: [
            {
              subscriptionId: 'subscription-a',
              subscriptionExpirationDateTime: '2026-07-18T12:00:00.000Z',
              resource: 'users/fixture/messages/a',
              clientState: 'attacker-state',
            },
          ],
        }),
      ),
      GRAPH_FIXTURE_CLIENT_STATE,
    );
    expect(result.kind).toBe('notifications');
    if (result.kind === 'notifications') {
      expect(result.verification).toEqual({
        verified: false,
        reasonCode: 'graph_client_state_mismatch',
      });
      expect(result.notifications).toHaveLength(0);
    }
  });

  it('maps lifecycle events to bounded renew, recreate, and delta recovery work', () => {
    const result = inspectGraphNotificationRequest(
      request(graphNotificationBodyBase64(graphLifecycleFixture)),
      GRAPH_FIXTURE_CLIENT_STATE,
    );
    expect(result.kind).toBe('notifications');
    if (result.kind === 'notifications') {
      expect(result.verification.verified).toBe(true);
      expect(result.lifecycleActions.map((action) => action.action)).toEqual([
        'renew',
        'recreate',
        'delta_reconcile',
      ]);
    }
  });
});
