import type {
  EffectExecutionArtifact,
  ProviderSendResult,
} from '@chief/contracts/approval';
import type {
  ConnectorAccount,
  WorkObjectFact,
  WorkObjectRef,
  WorkManagementDescriptor,
} from '@chief/contracts/connectors';

import type {
  AuthorizationCallback,
  AuthorizationInput,
  AuthorizationStart,
  AuthorizationStrategyDescriptor,
  ConnectionHealth,
  ConnectorAccountRef,
  CredentialConnectionInput,
} from './authorization.js';
import type { PollRequest, SyncPage } from './checkpoint.js';
import type {
  ProviderSubscriptionResult,
  SubscriptionMutationRequest,
} from './subscription.js';

interface WorkManagementConnectorCommon {
  readonly connectorKind: 'work_management';
  descriptor(): WorkManagementDescriptor;
  authorizationStrategy(): AuthorizationStrategyDescriptor;
  validateConnection(account: ConnectorAccountRef): Promise<ConnectionHealth>;
  subscribe?(
    account: ConnectorAccountRef,
    request: SubscriptionMutationRequest,
  ): Promise<ProviderSubscriptionResult>;
  renewSubscription?(
    account: ConnectorAccountRef,
    request: SubscriptionMutationRequest,
  ): Promise<ProviderSubscriptionResult>;
  poll?(account: ConnectorAccountRef, request: PollRequest): Promise<SyncPage>;
  fetchObject?(
    account: ConnectorAccount,
    ref: WorkObjectRef,
  ): Promise<WorkObjectFact>;
  execute?(
    account: ConnectorAccountRef,
    artifact: EffectExecutionArtifact,
  ): Promise<ProviderSendResult>;
  reconcileEffect?(
    account: ConnectorAccountRef,
    artifact: EffectExecutionArtifact,
  ): Promise<ProviderSendResult>;
}

type OAuthWorkManagementConnector = WorkManagementConnectorCommon & {
  authorizationStrategy(): Extract<
    AuthorizationStrategyDescriptor,
    { readonly strategy: 'oauth' }
  >;
  beginAuthorization(input: AuthorizationInput): Promise<AuthorizationStart>;
  completeAuthorization(
    input: AuthorizationCallback,
  ): Promise<ConnectorAccount>;
  configureCredentialConnection?: never;
};

type CredentialWorkManagementConnector = WorkManagementConnectorCommon & {
  authorizationStrategy(): Extract<
    AuthorizationStrategyDescriptor,
    { readonly strategy: 'credential' }
  >;
  configureCredentialConnection(
    input: CredentialConnectionInput,
  ): Promise<ConnectorAccount>;
  beginAuthorization?: never;
  completeAuthorization?: never;
};

type ExternalWorkManagementConnector = WorkManagementConnectorCommon & {
  authorizationStrategy(): Extract<
    AuthorizationStrategyDescriptor,
    { readonly strategy: 'external' }
  >;
  beginAuthorization?: never;
  completeAuthorization?: never;
  configureCredentialConnection?: never;
};

type NoAuthorizationWorkManagementConnector = WorkManagementConnectorCommon & {
  authorizationStrategy(): Extract<
    AuthorizationStrategyDescriptor,
    { readonly strategy: 'none' }
  >;
  beginAuthorization?: never;
  completeAuthorization?: never;
  configureCredentialConnection?: never;
};

export type WorkManagementConnector =
  | OAuthWorkManagementConnector
  | CredentialWorkManagementConnector
  | ExternalWorkManagementConnector
  | NoAuthorizationWorkManagementConnector;
