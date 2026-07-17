import { createHash } from 'node:crypto';

import { actionPlanSchema, type ActionPlan } from '@chief/contracts/approval';

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('CANONICAL_NON_FINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new Error('CANONICAL_UNSUPPORTED_VALUE');
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

export function actionPlanCanonicalPayload(
  input: ActionPlan,
): Readonly<Record<string, unknown>> {
  const plan = actionPlanSchema.parse(input);
  return {
    schemaVersion: plan.schemaVersion,
    tenantId: plan.tenantId,
    actionPlanId: plan.actionPlanId,
    revision: plan.revision,
    sourceMessageRevisionId: plan.sourceMessageRevisionId,
    operations: plan.operations,
    policyVersion: plan.policyVersion,
    expiresAt: plan.expiresAt,
    createdAt: plan.createdAt,
  };
}

export function computeActionPlanHash(input: ActionPlan): string {
  return canonicalSha256(actionPlanCanonicalPayload(input));
}

export function assertExactActionPlanHash(input: ActionPlan): void {
  const actual = computeActionPlanHash(input);
  if (actual !== input.canonicalHash) {
    throw new Error('ACTION_PLAN_HASH_MISMATCH');
  }
}

export function immutable<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) immutable(nested);
    Object.freeze(value);
  }
  return value;
}
