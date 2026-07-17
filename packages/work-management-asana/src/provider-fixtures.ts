import {
  effectExecutionArtifactSchema,
  type EffectExecutionArtifact,
} from '@chief/contracts/approval';
import {
  connectorAccountSchema,
  connectorSnapshotSchema,
} from '@chief/contracts/connectors';

import { sha256 } from './canonical.js';
import { asanaWorkManagementConnectorDescriptor } from './implementation-metadata.js';
import type {
  AsanaEffectPayload,
  AsanaRequest,
  AsanaResponse,
} from './types.js';

export const ASANA_FIXTURE_NOW = '2026-07-17T12:00:00.000Z';
export const ASANA_FIXTURE_LATER = '2026-07-17T12:05:00.000Z';
export const ASANA_FIXTURE_KEYED_DIGEST =
  'h1_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as const;

export const asanaFixtureSnapshot = connectorSnapshotSchema.parse({
  connectorId: asanaWorkManagementConnectorDescriptor.connectorId,
  descriptorVersion: asanaWorkManagementConnectorDescriptor.descriptorVersion,
  accountId: 'asana-account-a',
  capabilitySnapshotHash: sha256(
    asanaWorkManagementConnectorDescriptor.capabilities,
  ),
  runtimeMode: 'virtual_test',
  selectionState: 'selected',
});

export const asanaFixtureAccount = connectorAccountSchema.parse({
  tenantId: 'tenant-a',
  accountId: asanaFixtureSnapshot.accountId,
  ownerUserId: 'user-a',
  brandId: 'brand-a',
  provider: 'asana',
  channel: 'work_management',
  providerAccountDigest: ASANA_FIXTURE_KEYED_DIGEST,
  displayLabel: 'Provider-shaped Asana fixture workspace',
  snapshot: asanaFixtureSnapshot,
  status: 'active',
  health: 'healthy',
  stateVersion: 1,
  updatedAt: ASANA_FIXTURE_NOW,
});

export const asanaFixtureTask = {
  data: {
    gid: 'task-a',
    resource_type: 'task',
    resource_subtype: 'default_task',
    name: 'Prepare board update',
    modified_at: ASANA_FIXTURE_NOW,
    permalink_url: 'https://app.asana.com/0/project-a/task-a',
    workspace: { gid: 'workspace-a', resource_type: 'workspace' },
    memberships: [
      {
        project: { gid: 'project-a', resource_type: 'project' },
        section: { gid: 'section-a', resource_type: 'section' },
      },
    ],
  },
} as const;

export const asanaFixtureProject = {
  data: {
    gid: 'project-a',
    resource_type: 'project',
    name: 'Executive operations',
    modified_at: ASANA_FIXTURE_NOW,
    permalink_url: 'https://app.asana.com/0/project-a/list',
    workspace: { gid: 'workspace-a', resource_type: 'workspace' },
  },
} as const;

export const asanaFixtureMilestone = {
  data: {
    gid: 'milestone-a',
    resource_type: 'task',
    resource_subtype: 'milestone',
    name: 'Board pack approved',
    modified_at: ASANA_FIXTURE_NOW,
    permalink_url: 'https://app.asana.com/0/project-a/milestone-a',
    workspace: { gid: 'workspace-a', resource_type: 'workspace' },
    memberships: [{ project: { gid: 'project-a', resource_type: 'project' } }],
  },
} as const;

export const asanaFixtureComment = {
  data: {
    gid: 'comment-a',
    resource_type: 'story',
    resource_subtype: 'comment_added',
    text: 'Finance confirmed the figures.',
    created_at: ASANA_FIXTURE_NOW,
    target: {
      gid: 'task-a',
      resource_type: 'task',
      workspace: { gid: 'workspace-a', resource_type: 'workspace' },
      projects: [{ gid: 'project-a', resource_type: 'project' }],
    },
  },
} as const;

export const asanaFixtureUpdatePayload: AsanaEffectPayload = {
  kind: 'update_task',
  taskGid: 'task-a',
  fields: { completed: true },
  precondition: { modifiedAt: ASANA_FIXTURE_NOW },
};

export function asanaFixtureArtifact(
  payload: AsanaEffectPayload,
  operationId = 'asana-operation-a',
): EffectExecutionArtifact {
  return effectExecutionArtifactSchema.parse({
    schemaVersion: '1',
    tenantId: asanaFixtureAccount.tenantId,
    operationId,
    attemptId: `${operationId}-attempt-1`,
    stableIdempotencyKey: `${operationId}-stable`,
    account: {
      tenantId: asanaFixtureAccount.tenantId,
      accountId: asanaFixtureAccount.accountId,
      expectedStateVersion: asanaFixtureAccount.stateVersion,
    },
    sourceMessageRevisionId: 'message-revision-a',
    actionPlanId: 'action-plan-a',
    actionPlanHash: 'a'.repeat(64),
    approvalId: 'approval-a',
    renderedPayloadFingerprint: sha256(payload),
    connectorSnapshot: asanaFixtureSnapshot,
    clientCorrelation: {
      kind: 'client_reference',
      value: operationId,
    },
    correlationBindingVersion: '1',
    reconciliationStrategy: 'asana-bounded-object-lookup',
    reconciliationStrategyVersion: '1',
    createdAt: ASANA_FIXTURE_NOW,
  });
}

export function providerResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): AsanaResponse {
  return { status, headers, body };
}

export type AsanaFixtureRoute = (
  request: AsanaRequest,
) => AsanaResponse | Promise<AsanaResponse>;
