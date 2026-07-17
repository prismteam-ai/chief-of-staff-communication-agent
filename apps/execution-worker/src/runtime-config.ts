export interface ProductionExecutionConfig {
  readonly runtimeMode: 'effect_disabled';
  readonly coreTableName: string;
  readonly workerId: string;
  readonly leaseDurationMs: number;
}

export class ExecutionConfigurationError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'ExecutionConfigurationError';
  }
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new ExecutionConfigurationError(`MISSING_${name}`);
  }
  if (value !== value.trim()) {
    throw new ExecutionConfigurationError(`INVALID_${name}`);
  }
  return value;
}

function resourceName(value: string, name: string): string {
  if (!/^[A-Za-z0-9_.-]{3,255}$/u.test(value)) {
    throw new ExecutionConfigurationError(`INVALID_${name}`);
  }
  return value;
}

function workerId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u.test(value)) {
    throw new ExecutionConfigurationError('INVALID_EXECUTION_WORKER_ID');
  }
  return value;
}

function leaseDuration(value: string): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new ExecutionConfigurationError(
      'INVALID_EXECUTION_LEASE_DURATION_MS',
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 15 * 60_000) {
    throw new ExecutionConfigurationError(
      'INVALID_EXECUTION_LEASE_DURATION_MS',
    );
  }
  return parsed;
}

function requireDisabled(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): void {
  if (required(environment, name) !== 'disabled') {
    throw new ExecutionConfigurationError(`INVALID_${name}`);
  }
}

export function loadProductionExecutionConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ProductionExecutionConfig {
  if (required(environment, 'EXECUTION_RUNTIME_MODE') !== 'effect_disabled') {
    throw new ExecutionConfigurationError('INVALID_EXECUTION_RUNTIME_MODE');
  }
  for (const effectSwitch of [
    'EXTERNAL_EFFECTS',
    'MODEL_EFFECTS',
    'PROVIDER_EFFECTS',
    'WORK_MANAGEMENT_EFFECTS',
  ]) {
    requireDisabled(environment, effectSwitch);
  }
  return Object.freeze({
    runtimeMode: 'effect_disabled',
    coreTableName: resourceName(
      required(environment, 'CORE_TABLE_NAME'),
      'CORE_TABLE_NAME',
    ),
    workerId: workerId(required(environment, 'EXECUTION_WORKER_ID')),
    leaseDurationMs: leaseDuration(
      required(environment, 'EXECUTION_LEASE_DURATION_MS'),
    ),
  });
}
