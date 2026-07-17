import type { DomainErrorCode, TenantId } from '@chief/contracts';

export class DomainInvariantError extends Error {
  public constructor(
    public readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainInvariantError';
  }
}

export function assertTenant(expected: TenantId, actual: TenantId): void {
  if (expected !== actual) {
    throw new DomainInvariantError(
      'CROSS_TENANT_ACCESS',
      'tenant scope does not match the aggregate owner',
    );
  }
}

export function assertExpected(
  actual: number,
  expected: number,
  kind: 'revision' | 'epoch',
): void {
  if (actual !== expected) {
    throw new DomainInvariantError(
      kind === 'revision' ? 'STALE_REVISION' : 'STALE_EPOCH',
      `expected ${kind} ${String(expected)}, found ${String(actual)}`,
    );
  }
}

export function immutable<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function instantMilliseconds(timestamp: string): number {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      'timestamp must identify a valid instant',
    );
  }
  return milliseconds;
}

export function compareInstants(left: string, right: string): number {
  return instantMilliseconds(left) - instantMilliseconds(right);
}
