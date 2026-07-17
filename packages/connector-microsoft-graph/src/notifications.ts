import type {
  RawWebhookRequest,
  WebhookVerification,
} from '@chief/contracts/connectors';

import type {
  GraphNotification,
  GraphNotificationCollection,
} from './graph-types.js';
import { decodeBase64Json, sha256 } from './hash.js';

export type GraphNotificationRequestResult =
  | {
      readonly kind: 'validation_challenge';
      readonly status: 200;
      readonly contentType: 'text/plain';
      readonly body: string;
    }
  | {
      readonly kind: 'notifications';
      readonly verification: WebhookVerification;
      readonly notifications: readonly GraphNotification[];
      readonly lifecycleActions: readonly GraphLifecycleAction[];
    };

export interface GraphLifecycleAction {
  readonly subscriptionId: string;
  readonly action: 'renew' | 'recreate' | 'delta_reconcile';
  readonly reason: string;
}

export function inspectGraphNotificationRequest(
  request: RawWebhookRequest,
  expectedClientState: string,
): GraphNotificationRequestResult {
  const validationToken = new URL(request.providerVisibleUrl).searchParams.get(
    'validationToken',
  );
  if (validationToken !== null) {
    return {
      kind: 'validation_challenge',
      status: 200,
      contentType: 'text/plain',
      body: validationToken,
    };
  }
  let decoded: unknown;
  try {
    decoded = decodeBase64Json<unknown>(request.rawBodyBase64);
  } catch {
    return rejected('graph_malformed_json');
  }
  if (!isNotificationCollection(decoded) || decoded.value.length === 0) {
    return rejected('graph_empty_notification');
  }
  const payload = decoded;
  if (
    payload.value.some(
      (notification) => notification.clientState !== expectedClientState,
    )
  ) {
    return rejected('graph_client_state_mismatch');
  }
  const rawPayload = Buffer.from(request.rawBodyBase64, 'base64');
  const digest = sha256(rawPayload);
  return {
    kind: 'notifications',
    verification: {
      verified: true,
      verificationMethod: 'graph-client-state-v1',
      providerEventId: `graph-event-${digest.slice(0, 32)}`,
      rawPayloadDigest: digest,
    },
    notifications: payload.value,
    lifecycleActions: payload.value.flatMap(toLifecycleAction),
  };
}

function isNotificationCollection(
  value: unknown,
): value is GraphNotificationCollection {
  if (typeof value !== 'object' || value === null || !('value' in value)) {
    return false;
  }
  const notifications = Reflect.get(value, 'value');
  return (
    Array.isArray(notifications) &&
    notifications.every(
      (notification: unknown) =>
        typeof notification === 'object' &&
        notification !== null &&
        typeof Reflect.get(notification, 'subscriptionId') === 'string' &&
        typeof Reflect.get(notification, 'resource') === 'string' &&
        typeof Reflect.get(notification, 'subscriptionExpirationDateTime') ===
          'string',
    )
  );
}

function rejected(
  reasonCode: string,
): Extract<GraphNotificationRequestResult, { readonly kind: 'notifications' }> {
  return {
    kind: 'notifications',
    verification: { verified: false, reasonCode },
    notifications: [],
    lifecycleActions: [],
  };
}

function toLifecycleAction(
  notification: GraphNotification,
): GraphLifecycleAction[] {
  switch (notification.lifecycleEvent) {
    case 'reauthorizationRequired':
      return [
        {
          subscriptionId: notification.subscriptionId,
          action: 'renew',
          reason: notification.lifecycleEvent,
        },
      ];
    case 'subscriptionRemoved':
      return [
        {
          subscriptionId: notification.subscriptionId,
          action: 'recreate',
          reason: notification.lifecycleEvent,
        },
      ];
    case 'missed':
      return [
        {
          subscriptionId: notification.subscriptionId,
          action: 'delta_reconcile',
          reason: notification.lifecycleEvent,
        },
      ];
    default:
      return [];
  }
}
