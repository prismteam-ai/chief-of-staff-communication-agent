import {
  workManagementDescriptorSchema,
  type WorkManagementDescriptor,
} from '@chief/contracts/connectors';

const descriptor = workManagementDescriptorSchema.parse({
  schemaVersion: '1',
  connectorId: 'asana-work-management',
  descriptorVersion: '1.0.0',
  provider: 'asana',
  connectionStrategy: 'oauth',
  authorizationAudience: 'asana-api',
  authorizationScopes: ['default'],
  supportedRuntimeModes: ['live', 'virtual_test', 'disabled'],
  capabilities: {
    readTasks: true,
    readProjects: true,
    readMilestones: true,
    readComments: true,
    createTask: true,
    updateTask: true,
    createComment: true,
    webhooks: true,
    attachments: false,
    multipleAccounts: true,
    externalEffect: true,
  },
  constraints: [
    'WorkManagementConnector only; never register as CommunicationConnector.',
    'Provider I/O remains constructor-injected; the production REST transport is hard-bound to the Asana API origin and receives credentials only through an injected redacting source.',
    'Ambiguous effects freeze for reconciliation and never enter ordinary retry.',
  ],
});

Object.freeze(descriptor.authorizationScopes);
Object.freeze(descriptor.supportedRuntimeModes);
Object.freeze(descriptor.capabilities);
Object.freeze(descriptor.constraints);

export const asanaWorkManagementConnectorDescriptor: WorkManagementDescriptor =
  Object.freeze(descriptor);
