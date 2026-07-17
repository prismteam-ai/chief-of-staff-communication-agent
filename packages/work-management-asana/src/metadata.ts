import {
  workManagementDescriptorSchema,
  type WorkManagementDescriptor,
} from '@chief/contracts/connectors';

const parsedMetadata = workManagementDescriptorSchema.parse({
  schemaVersion: '1',
  connectorId: 'asana-work-management',
  descriptorVersion: '1.0.0-scaffold',
  provider: 'asana',
  connectionStrategy: 'oauth',
  authorizationAudience: 'asana-api',
  authorizationScopes: ['default'],
  supportedRuntimeModes: ['disabled'],
  capabilities: {
    readTasks: false,
    readProjects: false,
    readMilestones: false,
    readComments: false,
    createTask: false,
    updateTask: false,
    createComment: false,
    webhooks: false,
    attachments: false,
    multipleAccounts: false,
    externalEffect: false,
  },
  constraints: [
    'Work-management scaffold only; this is not a CommunicationConnector and performs no Asana operation.',
  ],
});

Object.freeze(parsedMetadata.authorizationScopes);
Object.freeze(parsedMetadata.supportedRuntimeModes);
Object.freeze(parsedMetadata.capabilities);
Object.freeze(parsedMetadata.constraints);

export const asanaWorkManagementMetadata: WorkManagementDescriptor =
  Object.freeze(parsedMetadata);
