import { gmailConnectorDescriptor } from './descriptor.js';

const descriptor = gmailConnectorDescriptor();

export const gmailConnectorMetadata = Object.freeze({
  ...descriptor,
  authorizationScopes: Object.freeze([...descriptor.authorizationScopes]),
  capabilities: Object.freeze({ ...descriptor.capabilities }),
  supportedRuntimeModes: Object.freeze([...descriptor.supportedRuntimeModes]),
  constraints: Object.freeze([...descriptor.constraints]),
});
