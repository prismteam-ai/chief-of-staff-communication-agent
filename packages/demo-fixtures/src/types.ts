import type {
  ActionPlan,
  ActionRecommendation,
  Approval,
  Attachment,
  ConnectorAccount,
  ContactChannelPolicy,
  DraftRevision,
  KnowledgeChunk,
  KnowledgeSource,
  Message,
  MessageRevision,
  ProviderThread,
  SuppressionFact,
  Topic,
  TopicLink,
  WorkObjectFact,
} from '@chief/contracts';
import type {
  membershipSchema,
  tenantSchema,
  userSchema,
} from '@chief/contracts';

type Tenant = ReturnType<typeof tenantSchema.parse>;
type User = ReturnType<typeof userSchema.parse>;
type Membership = ReturnType<typeof membershipSchema.parse>;

export const DEMO_SCHEMA_VERSION = '1' as const;
export const DEFAULT_DEMO_SEED = 20_260_717;
export const DEFAULT_DEMO_CLOCK = '2026-07-17T09:00:00.000Z';

export const demoChannels = [
  'gmail',
  'microsoft_graph',
  'sms',
  'whatsapp',
  'x',
  'linkedin_archive',
  'future_demo',
] as const;

export type DemoChannel = (typeof demoChannels)[number];
export type DemoResponseStatus =
  'answered' | 'pending' | 'overdue' | 'no_action';

export interface DemoBrandFixture {
  readonly tenantId: string;
  readonly brandId: string;
  readonly name: string;
  readonly accountIds: readonly string[];
}

export interface DemoPersonFixture {
  readonly tenantId: string;
  readonly personId: string;
  readonly displayName: string;
  readonly organization: string;
  readonly identityDigests: readonly string[];
  readonly ambiguousWithPersonId?: string;
}

export interface DemoBodyFixture {
  readonly tenantId: string;
  readonly sourceRef: string;
  readonly bodyText: string;
  readonly contentHash: string;
  readonly classification:
    'communication' | 'attachment' | 'asana' | 'organization' | 'style';
}

export interface DemoCommunicationState {
  readonly tenantId: string;
  readonly messageRevisionId: string;
  readonly responseStatus: DemoResponseStatus;
  readonly ingressReceivedAt: string;
  readonly actionableAt: string;
  readonly answeredAt?: string;
  readonly deadlineAt: string;
  readonly sourceTimestampTrusted: boolean;
  readonly capabilityLabel: string;
}

export interface DemoStyleExample {
  readonly tenantId: string;
  readonly brandId: string;
  readonly sourceId: string;
  readonly messageRevisionId: string;
  readonly approved: true;
  readonly channel: DemoChannel;
  readonly styleTags: readonly string[];
}

export interface DemoEdgeCase {
  readonly caseId: string;
  readonly tenantId: string;
  readonly messageRevisionId: string;
  readonly category:
    | 'prompt_injection'
    | 'ambiguous_identity'
    | 'suppression'
    | 'consent_window'
    | 'out_of_order'
    | 'duplicate'
    | 'attachment_limit'
    | 'deletion'
    | 'cross_tenant';
  readonly expectedBehavior: string;
}

export interface DemoCapabilityLabel {
  readonly accountId: string;
  readonly channel: DemoChannel | 'asana';
  readonly mode: 'fixture' | 'manual';
  readonly read: boolean;
  readonly send: false;
  readonly externalEffect: false;
  readonly limitation: string;
}

export interface DemoAsanaObject {
  readonly tenantId: string;
  readonly object: WorkObjectFact;
  readonly title: string;
  readonly projectRef?: string;
  readonly parentTaskRef?: string;
  readonly assigneeLabel?: string;
  readonly dueAt?: string;
  readonly status: 'open' | 'blocked' | 'complete' | 'informational';
}

export interface DemoExpectedSla {
  readonly totalInbound: number;
  readonly answered: number;
  readonly pending: number;
  readonly overdue: number;
  readonly actionableWithinFiveMinutes: number;
  readonly trustedIngressToActionableP95Ms: number;
  readonly targetMs: 180_000;
}

export interface DemoScenario {
  readonly scenarioId: 'northstar-launch-readiness';
  readonly title: string;
  readonly tenantId: string;
  readonly primaryMessageRevisionId: string;
  readonly relatedMessageRevisionIds: readonly string[];
  readonly topicId: string;
  readonly recommendation: ActionRecommendation;
  readonly draft: DraftRevision;
  readonly actionPlan: ActionPlan;
  readonly approvals: readonly Approval[];
  readonly expectedAsanaHandoff: {
    readonly operationId: string;
    readonly taskRef: string;
    readonly expectedStatus: 'approved_effect_disabled';
  };
  readonly expectedSla: DemoExpectedSla;
  readonly capabilityLabels: readonly DemoCapabilityLabel[];
  readonly walkthrough: readonly string[];
}

export interface DemoCorpusCounts {
  readonly tenants: number;
  readonly brands: number;
  readonly accounts: number;
  readonly threads: number;
  readonly messages: number;
  readonly attachments: number;
  readonly asanaObjects: number;
  readonly styleExamples: number;
  readonly edgeCases: number;
  readonly knowledgeSources: number;
  readonly knowledgeChunks: number;
}

export interface DemoCorpusManifest {
  readonly schemaVersion: typeof DEMO_SCHEMA_VERSION;
  readonly seed: number;
  readonly generatedAt: string;
  readonly syntheticOnly: true;
  readonly corpusHash: string;
  readonly counts: DemoCorpusCounts;
  readonly channelCoverage: readonly DemoChannel[];
  readonly resetVersion: 'demo-reset-v1';
}

export interface DemoCorpus {
  readonly manifest: DemoCorpusManifest;
  readonly tenants: readonly Tenant[];
  readonly users: readonly User[];
  readonly memberships: readonly Membership[];
  readonly brands: readonly DemoBrandFixture[];
  readonly accounts: readonly ConnectorAccount[];
  readonly people: readonly DemoPersonFixture[];
  readonly threads: readonly ProviderThread[];
  readonly messages: readonly Message[];
  readonly messageRevisions: readonly MessageRevision[];
  readonly bodies: readonly DemoBodyFixture[];
  readonly attachments: readonly Attachment[];
  readonly topics: readonly Topic[];
  readonly topicLinks: readonly TopicLink[];
  readonly communicationStates: readonly DemoCommunicationState[];
  readonly suppressionFacts: readonly SuppressionFact[];
  readonly contactPolicies: readonly ContactChannelPolicy[];
  readonly asanaObjects: readonly DemoAsanaObject[];
  readonly styleExamples: readonly DemoStyleExample[];
  readonly knowledgeSources: readonly KnowledgeSource[];
  readonly knowledgeChunks: readonly KnowledgeChunk[];
  readonly edgeCases: readonly DemoEdgeCase[];
  readonly scenario: DemoScenario;
}

export interface DemoValidationReport {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly counts: DemoCorpusCounts;
  readonly channelCoverage: readonly DemoChannel[];
  readonly computedHash: string;
}
