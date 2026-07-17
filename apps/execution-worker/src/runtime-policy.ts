import type { EffectExecutionArtifact } from '@chief/contracts/approval';

export type ControlledEffectKind = 'communication' | 'work_management';
export type ControlledEffectOperation =
  'send_message' | 'create_task' | 'update_task' | 'create_comment';

export interface ControlledEffectEnvelope {
  readonly kind: ControlledEffectKind;
  readonly operation: ControlledEffectOperation;
  readonly tenantId: string;
  readonly operationId: string;
  readonly actionPlanHash: string;
  readonly accountId: string;
  readonly connectorId: string;
  readonly descriptorVersion: string;
  readonly capabilitySnapshotHash: string;
  readonly renderedPayloadFingerprint: string;
}

export interface RuntimeEffectPolicy {
  authorize(
    artifact: EffectExecutionArtifact,
  ): Promise<ControlledEffectEnvelope>;
}

export class ExternalEffectDeniedError extends Error {
  public constructor(message = 'EXACT_EXTERNAL_EFFECT_NOT_ENABLED') {
    super(message);
    this.name = 'ExternalEffectDeniedError';
  }
}

function envelopeMatches(
  allowed: ControlledEffectEnvelope,
  artifact: EffectExecutionArtifact,
): boolean {
  return (
    allowed.tenantId === artifact.tenantId &&
    allowed.operationId === artifact.operationId &&
    allowed.actionPlanHash === artifact.actionPlanHash &&
    allowed.accountId === artifact.account.accountId &&
    allowed.connectorId === artifact.connectorSnapshot.connectorId &&
    allowed.descriptorVersion ===
      artifact.connectorSnapshot.descriptorVersion &&
    allowed.capabilitySnapshotHash ===
      artifact.connectorSnapshot.capabilitySnapshotHash &&
    allowed.renderedPayloadFingerprint === artifact.renderedPayloadFingerprint
  );
}

export class DefaultDenyRuntimeEffectPolicy implements RuntimeEffectPolicy {
  public authorize(
    _artifact: EffectExecutionArtifact,
  ): Promise<ControlledEffectEnvelope> {
    return Promise.reject(new ExternalEffectDeniedError());
  }
}

/**
 * A deliberately narrow runtime switch. Each entry authorizes one immutable
 * operation only; there are no provider-wide or tenant-wide wildcards.
 */
export class ExactEnvelopeRuntimeEffectPolicy implements RuntimeEffectPolicy {
  readonly #allowed: readonly ControlledEffectEnvelope[];

  public constructor(allowed: readonly ControlledEffectEnvelope[]) {
    this.#allowed = Object.freeze(
      allowed.map((entry) => Object.freeze({ ...entry })),
    );
  }

  public authorize(
    artifact: EffectExecutionArtifact,
  ): Promise<ControlledEffectEnvelope> {
    const match = this.#allowed.find((candidate) =>
      envelopeMatches(candidate, artifact),
    );
    if (match === undefined) {
      return Promise.reject(new ExternalEffectDeniedError());
    }
    return Promise.resolve(match);
  }
}
