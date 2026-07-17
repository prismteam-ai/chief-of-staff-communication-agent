import type {
  ContactChannelPolicy,
  SuppressionFact,
  TenantId,
} from '@chief/contracts';

import {
  assertTenant,
  compareInstants,
  DomainInvariantError,
  immutable,
  instantMilliseconds,
} from './invariants.js';

const suppressions = new Set<SuppressionFact['kind']>([
  'provider_opt_out',
  'unsubscribe',
  'complaint',
  'bounce',
  'legal_block',
  'operator_block',
]);
const allows = new Set<SuppressionFact['kind']>([
  'controlled_recipient_allow',
  'verified_opt_in',
  'verified_reconsent',
]);

function appliesAt(fact: SuppressionFact, observedAt: string): boolean {
  const observed = instantMilliseconds(observedAt);
  return (
    instantMilliseconds(fact.effectiveAt) <= observed &&
    (fact.expiresAt === undefined ||
      instantMilliseconds(fact.expiresAt) > observed)
  );
}

export function reduceContactPolicy(input: {
  readonly actorTenantId: TenantId;
  readonly facts: readonly SuppressionFact[];
  readonly observedAt: string;
  readonly reducerVersion: string;
  readonly previous?: ContactChannelPolicy;
}): Readonly<ContactChannelPolicy> {
  if (input.facts.length === 0 && input.previous === undefined) {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      'contact policy requires a scope from a prior projection or fact',
    );
  }
  const scope = input.facts[0] ?? input.previous;
  if (scope === undefined) {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      'missing policy scope',
    );
  }
  assertTenant(input.actorTenantId, scope.tenantId);
  if (input.previous !== undefined) {
    assertTenant(scope.tenantId, input.previous.tenantId);
    if (
      input.previous.contactIdentityDigest !== scope.contactIdentityDigest ||
      input.previous.channel !== scope.channel ||
      input.previous.connectorAccountId !== scope.connectorAccountId ||
      input.previous.brandId !== scope.brandId
    ) {
      throw new DomainInvariantError(
        'CROSS_TENANT_ACCESS',
        'previous contact policy cannot cross identity, channel, account, or brand scope',
      );
    }
  }
  for (const fact of input.facts) {
    assertTenant(scope.tenantId, fact.tenantId);
    if (
      fact.contactIdentityDigest !== scope.contactIdentityDigest ||
      fact.channel !== scope.channel ||
      fact.connectorAccountId !== scope.connectorAccountId ||
      fact.brandId !== scope.brandId
    ) {
      throw new DomainInvariantError(
        'CROSS_TENANT_ACCESS',
        'contact facts cannot cross identity, channel, account, or brand scope',
      );
    }
  }
  const active = input.facts
    .filter((fact) => appliesAt(fact, input.observedAt))
    .sort((left, right) =>
      compareInstants(left.effectiveAt, right.effectiveAt) === 0
        ? left.factId.localeCompare(right.factId)
        : compareInstants(left.effectiveAt, right.effectiveAt),
    );
  const byId = new Map(active.map((fact) => [fact.factId, fact]));
  const superseded = new Set(
    active.flatMap((fact) => {
      if (fact.supersedesFactId === undefined) {
        return [];
      }
      const target = byId.get(fact.supersedesFactId);
      const validProviderReconsent =
        fact.kind === 'verified_reconsent' &&
        target?.authority === 'provider' &&
        (target.kind === 'provider_opt_out' || target.kind === 'unsubscribe');
      const validWindowReopen =
        fact.kind === 'window_open' && target?.kind === 'window_closed';
      return validProviderReconsent || validWindowReopen
        ? [fact.supersedesFactId]
        : [];
    }),
  );
  const effective = active.filter((fact) => !superseded.has(fact.factId));
  const restrictive = effective.filter((fact) => suppressions.has(fact.kind));
  const closed = effective.filter((fact) => fact.kind === 'window_closed');
  const open = effective.filter((fact) => fact.kind === 'window_open');
  const allowed = effective.filter((fact) => allows.has(fact.kind));
  const winner =
    restrictive.at(-1) ??
    closed.at(-1) ??
    (allowed.length > 0 && (open.length > 0 || scope.channel !== 'whatsapp')
      ? allowed.at(-1)
      : undefined);
  const state: ContactChannelPolicy['state'] =
    restrictive.length > 0
      ? 'suppressed'
      : closed.length > 0
        ? 'window_closed'
        : allowed.length > 0 &&
            (open.length > 0 || scope.channel !== 'whatsapp')
          ? 'allowed'
          : input.facts.length > 0
            ? 'consent_required'
            : 'unknown';
  return immutable({
    schemaVersion: '1',
    tenantId: scope.tenantId,
    contactIdentityDigest: scope.contactIdentityDigest,
    channel: scope.channel,
    connectorAccountId: scope.connectorAccountId,
    brandId: scope.brandId,
    state,
    ...(winner === undefined ? {} : { winningFactId: winner.factId }),
    applicableFactIds: active.map((fact) => fact.factId),
    reducerVersion: input.reducerVersion,
    projectionVersion: (input.previous?.projectionVersion ?? 0) + 1,
    updatedAt: input.observedAt,
  });
}

export function assertContactEligible(
  policy: ContactChannelPolicy,
  approvedPolicyVersion: number,
): void {
  if (policy.projectionVersion !== approvedPolicyVersion) {
    throw new DomainInvariantError(
      'STALE_REVISION',
      'contact policy changed after approval',
    );
  }
  if (policy.state !== 'allowed') {
    throw new DomainInvariantError(
      'CONTACT_POLICY_BLOCKED',
      `contact policy is ${policy.state}`,
    );
  }
}
