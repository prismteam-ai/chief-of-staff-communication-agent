export const externalEffectControl = Object.freeze({
  schemaVersion: '1',
  defaultState: 'disabled',
  providerEffectsEnabled: false,
  workManagementEffectsEnabled: false,
} as const);

export class ExternalEffectsDisabledError extends Error {
  public constructor() {
    super('External effects are disabled by the server-owned product control.');
    this.name = 'ExternalEffectsDisabledError';
  }
}

export function assertExternalEffectsEnabled(
  enabled: boolean,
): asserts enabled {
  if (!enabled) throw new ExternalEffectsDisabledError();
}
