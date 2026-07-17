import { describe, expect, it } from 'vitest';

import {
  ExecutionConfigurationError,
  loadProductionExecutionConfig,
} from './runtime-config.js';

const VALID_ENVIRONMENT = Object.freeze({
  EXECUTION_RUNTIME_MODE: 'effect_disabled',
  CORE_TABLE_NAME: 'chief-core-table',
  EXECUTION_WORKER_ID: 'chief-execution-worker',
  EXECUTION_LEASE_DURATION_MS: '120000',
  EXTERNAL_EFFECTS: 'disabled',
  MODEL_EFFECTS: 'disabled',
  PROVIDER_EFFECTS: 'disabled',
  WORK_MANAGEMENT_EFFECTS: 'disabled',
});

describe('production execution configuration', () => {
  it('loads only the explicit effect-disabled production shape', () => {
    expect(loadProductionExecutionConfig(VALID_ENVIRONMENT)).toEqual({
      runtimeMode: 'effect_disabled',
      coreTableName: 'chief-core-table',
      workerId: 'chief-execution-worker',
      leaseDurationMs: 120_000,
    });
  });

  it.each([
    ['missing core table', { CORE_TABLE_NAME: undefined }],
    ['malformed table', { CORE_TABLE_NAME: 'bad table name' }],
    ['provider effects enabled', { PROVIDER_EFFECTS: 'enabled' }],
    ['external effects enabled', { EXTERNAL_EFFECTS: 'enabled' }],
    ['wrong runtime', { EXECUTION_RUNTIME_MODE: 'provider' }],
    ['caller-shaped worker id', { EXECUTION_WORKER_ID: ' worker ' }],
    ['short lease', { EXECUTION_LEASE_DURATION_MS: '999' }],
    ['non-numeric lease', { EXECUTION_LEASE_DURATION_MS: '30s' }],
  ])('fails closed for %s', (_label, override) => {
    expect(() =>
      loadProductionExecutionConfig({
        ...VALID_ENVIRONMENT,
        ...override,
      }),
    ).toThrow(ExecutionConfigurationError);
  });
});
