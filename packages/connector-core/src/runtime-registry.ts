import {
  authorizationStrategyDescriptorSchema,
  connectorDescriptorSchema,
  workManagementDescriptorSchema,
} from '@chief/contracts/connectors';

import type { CommunicationConnector } from './communication-connector.js';
import type { WorkManagementConnector } from './work-management-connector.js';

export class ConnectorContractError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Connector contract rejected: ${issues.join('; ')}`);
    this.name = 'ConnectorContractError';
    this.issues = issues;
  }
}

type MethodBearingConnector = CommunicationConnector | WorkManagementConnector;

function hasMethod(connector: MethodBearingConnector, method: string): boolean {
  return typeof Reflect.get(connector, method) === 'function';
}

function validateAuthorizationParity(
  connector: MethodBearingConnector,
): string[] {
  const parsedStrategy = authorizationStrategyDescriptorSchema.safeParse(
    connector.authorizationStrategy(),
  );
  if (!parsedStrategy.success) {
    return ['authorization strategy does not satisfy the canonical schema'];
  }
  const strategy = parsedStrategy.data;
  const descriptor = connector.descriptor();
  const issues: string[] = [];

  if (strategy.strategy !== descriptor.connectionStrategy) {
    issues.push('authorization strategy differs from descriptor');
  }

  const begin = hasMethod(connector, 'beginAuthorization');
  const complete = hasMethod(connector, 'completeAuthorization');
  const credential = hasMethod(connector, 'configureCredentialConnection');

  switch (strategy.strategy) {
    case 'oauth':
      if (!begin || !complete || credential) {
        issues.push(
          'oauth requires begin/complete authorization and forbids credential configuration',
        );
      }
      if (
        descriptor.authorizationAudience !== strategy.audience ||
        descriptor.authorizationScopes.join('\u0000') !==
          strategy.scopes.join('\u0000')
      ) {
        issues.push('oauth audience/scopes differ from descriptor');
      }
      break;
    case 'credential':
      if (begin || complete || !credential) {
        issues.push(
          'credential requires credential configuration and forbids oauth methods',
        );
      }
      if (
        descriptor.credentialReferenceClass !==
        strategy.credentialReferenceClass
      ) {
        issues.push('credential reference class differs from descriptor');
      }
      break;
    case 'external':
    case 'none':
      if (begin || complete || credential) {
        issues.push(
          `${strategy.strategy} strategy forbids oauth and credential methods`,
        );
      }
      break;
  }

  return issues;
}

export function communicationConnectorIssues(
  connector: CommunicationConnector,
): readonly string[] {
  const parsed = connectorDescriptorSchema.safeParse(connector.descriptor());
  const issues = [...validateAuthorizationParity(connector)];
  if (connector.connectorKind !== 'communication') {
    issues.push(
      'communication connector must declare connectorKind=communication',
    );
  }
  if (!parsed.success) {
    issues.push('descriptor does not satisfy the canonical schema');
    return issues;
  }

  const { capabilities } = parsed.data;
  const parity: ReadonlyArray<
    readonly [boolean, string, 'required' | 'forbidden']
  > = [
    [
      capabilities.read,
      'fetchMessage',
      capabilities.read ? 'required' : 'forbidden',
    ],
    [capabilities.send, 'send', capabilities.send ? 'required' : 'forbidden'],
    [
      capabilities.send,
      'reconcileSend',
      capabilities.send ? 'required' : 'forbidden',
    ],
    [capabilities.poll, 'poll', capabilities.poll ? 'required' : 'forbidden'],
    [
      capabilities.webhook,
      'verifyWebhook',
      capabilities.webhook ? 'required' : 'forbidden',
    ],
    [
      capabilities.webhook,
      'subscribe',
      capabilities.webhook ? 'required' : 'forbidden',
    ],
    [
      capabilities.webhook,
      'renewSubscription',
      capabilities.webhook ? 'required' : 'forbidden',
    ],
    [
      capabilities.threads,
      'fetchThread',
      capabilities.threads ? 'required' : 'forbidden',
    ],
    [
      capabilities.deliveryFeedback,
      'parseFeedbackEvent',
      capabilities.deliveryFeedback ? 'required' : 'forbidden',
    ],
  ];

  for (const [capability, method, expectation] of parity) {
    const exists = hasMethod(connector, method);
    if ((expectation === 'required' && !exists) || (!capability && exists)) {
      issues.push(`${method} is ${expectation} by the capability snapshot`);
    }
  }

  if (
    (capabilities.webhook || capabilities.poll) &&
    !hasMethod(connector, 'normalizeInboundEvent')
  ) {
    issues.push('inbound capability requires normalizeInboundEvent');
  }
  if (
    !capabilities.webhook &&
    !capabilities.poll &&
    hasMethod(connector, 'normalizeInboundEvent')
  ) {
    issues.push('normalizeInboundEvent exists without an inbound capability');
  }
  if (
    capabilities.externalEffect &&
    (!capabilities.send ||
      parsed.data.supportedRuntimeModes.every(
        (mode) =>
          mode === 'fixture' ||
          mode === 'manual' ||
          mode === 'blocked_external_access' ||
          mode === 'disabled',
      ))
  ) {
    issues.push(
      'externalEffect requires send and an effect-capable runtime mode',
    );
  }
  if (capabilities.send !== capabilities.externalEffect) {
    issues.push(
      'communication send and externalEffect capabilities must remain truthful',
    );
  }
  if (
    (capabilities.complaintFeedback ||
      capabilities.unsubscribeFeedback ||
      capabilities.optOutFeedback ||
      capabilities.reconsentFeedback ||
      capabilities.consentWindowEligibility) &&
    !capabilities.deliveryFeedback
  ) {
    issues.push('declared feedback signals require the feedback boundary');
  }

  return issues;
}

export function assertCommunicationConnector(
  connector: CommunicationConnector,
): void {
  const issues = communicationConnectorIssues(connector);
  if (issues.length > 0) {
    throw new ConnectorContractError(issues);
  }
}

export function workManagementConnectorIssues(
  connector: WorkManagementConnector,
): readonly string[] {
  const parsed = workManagementDescriptorSchema.safeParse(
    connector.descriptor(),
  );
  const issues = [...validateAuthorizationParity(connector)];
  if (connector.connectorKind !== 'work_management') {
    issues.push(
      'work-management connector must declare connectorKind=work_management',
    );
  }
  if (!parsed.success) {
    issues.push(
      'work-management descriptor does not satisfy the canonical schema',
    );
    return issues;
  }
  const capabilities = parsed.data.capabilities;
  const hasMutation =
    capabilities.createTask ||
    capabilities.updateTask ||
    capabilities.createComment;
  const execute = hasMethod(connector, 'execute');
  const reconcile = hasMethod(connector, 'reconcileEffect');
  if (hasMutation !== execute || hasMutation !== reconcile) {
    issues.push(
      'work-management mutation capabilities require execute and reconciliation parity',
    );
  }
  if (capabilities.externalEffect !== hasMutation) {
    issues.push(
      'work-management externalEffect must match declared mutation capabilities',
    );
  }
  const hasReadCapability =
    capabilities.readTasks ||
    capabilities.readProjects ||
    capabilities.readMilestones ||
    capabilities.readComments;
  if (hasReadCapability !== hasMethod(connector, 'fetchObject')) {
    issues.push(
      'work-management read capabilities require fetchObject method parity',
    );
  }
  if (
    capabilities.webhooks &&
    (!hasMethod(connector, 'subscribe') ||
      !hasMethod(connector, 'renewSubscription'))
  ) {
    issues.push(
      'work-management webhook capability requires subscribe and renewal methods',
    );
  }
  if (
    !capabilities.webhooks &&
    (hasMethod(connector, 'subscribe') ||
      hasMethod(connector, 'renewSubscription'))
  ) {
    issues.push(
      'work-management subscription methods exist without webhook capability',
    );
  }
  if (
    capabilities.externalEffect &&
    parsed.data.supportedRuntimeModes.every(
      (mode) =>
        mode === 'fixture' ||
        mode === 'manual' ||
        mode === 'blocked_external_access' ||
        mode === 'disabled',
    )
  ) {
    issues.push(
      'work-management externalEffect requires an effect-capable runtime mode',
    );
  }
  return issues;
}

export function assertWorkManagementConnector(
  connector: WorkManagementConnector,
): void {
  const issues = workManagementConnectorIssues(connector);
  if (issues.length > 0) {
    throw new ConnectorContractError(issues);
  }
}

export class ConnectorRuntimeRegistry {
  readonly #communication = new Map<string, CommunicationConnector>();
  readonly #workManagement = new Map<string, WorkManagementConnector>();

  public registerCommunication(connector: CommunicationConnector): void {
    assertCommunicationConnector(connector);
    const id = connector.descriptor().connectorId;
    if (this.#communication.has(id) || this.#workManagement.has(id)) {
      throw new ConnectorContractError([`duplicate connector id: ${id}`]);
    }
    this.#communication.set(id, connector);
  }

  public registerWorkManagement(connector: WorkManagementConnector): void {
    assertWorkManagementConnector(connector);
    const descriptor = connector.descriptor();
    if (
      this.#communication.has(descriptor.connectorId) ||
      this.#workManagement.has(descriptor.connectorId)
    ) {
      throw new ConnectorContractError([
        `duplicate connector id: ${descriptor.connectorId}`,
      ]);
    }
    this.#workManagement.set(descriptor.connectorId, connector);
  }

  public communication(connectorId: string): CommunicationConnector {
    const connector = this.#communication.get(connectorId);
    if (connector === undefined) {
      throw new ConnectorContractError([
        `communication connector not registered: ${connectorId}`,
      ]);
    }
    return connector;
  }

  public workManagement(connectorId: string): WorkManagementConnector {
    const connector = this.#workManagement.get(connectorId);
    if (connector === undefined) {
      throw new ConnectorContractError([
        `work-management connector not registered: ${connectorId}`,
      ]);
    }
    return connector;
  }
}
