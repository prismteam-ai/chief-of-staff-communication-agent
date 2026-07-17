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
    'Provider I/O is constructor-injected; no credential reader, default endpoint, or live client exists in this package.',
    'Ambiguous effects freeze for reconciliation and never enter ordinary retry.',
  ],
});

Object.freeze(descriptor.authorizationScopes);
Object.freeze(descriptor.supportedRuntimeModes);
Object.freeze(descriptor.capabilities);
Object.freeze(descriptor.constraints);

export const asanaWorkManagementConnectorDescriptor: WorkManagementDescriptor =
  Object.freeze(descriptor);
