import { createHash } from 'node:crypto';

import type {
  DraftArtifact,
  RecommendationArtifact,
} from '@chief/agent/application-agent';
import { deterministicId, immutableHash } from '@chief/agent/canonical';

import {
  attemptIdSchema,
  citationSchema,
  communicationDetailViewSchema,
  communicationSummaryViewSchema,
  connectorStatusViewSchema,
  connectorSnapshotSchema,
  contextRequestSchema,
  deterministicEvaluatorIdentityV1,
  deterministicEvaluatorIdentityV2,
  getApprovalStatusResultSchema,
  getCommunicationResultSchema,
  getConnectorStatusResultSchema,
  getRelatedAsanaWorkResultSchema,
  getSlaMetricsResultSchema,
  getThreadContextResultSchema,
  listCommunicationsResultSchema,
  proposalHandoffSchema,
  searchKnowledgeResultSchema,
  serverRequestContextSchema,
  sha256Schema,
  threadContextViewSchema,
  type ActionPlan,
  type CommunicationDetailView,
  type CommunicationSummaryView,
  type ConnectorStatusView,
  type Citation,
  type RetrievalCandidate,
} from '@chief/contracts';
import { resetDemoCorpus } from '@chief/demo-fixtures';
import {
  buildImmutableApprovalBundle,
  type OperationApprovalBinding,
} from '@chief/approval-outbox/approval-service';
import {
  buildDynamoApprovalExecutionRecords,
  type DynamoApprovalExecutionRecords,
} from '@chief/approval-outbox/dynamo-execution-persistence';
import { canonicalSha256 } from '@chief/approval-outbox/canonical';
import { PersistenceConflictError } from '@chief/persistence-dynamodb';
import type { AuthoritativeExecutionState } from '@chief/approval-outbox/execution-service';
import { createDeterministicDurableAgent } from './deterministic-agent-runtime.js';
import type {
  AtomicCurrentHeadCondition,
  DurableProductRepository,
} from './durable-product-repository.js';
import {
  approveProposalResultSchema,
  dashboardMetricsResultSchema,
  executionStatusResultSchema,
  prepareDraftApprovalResultSchema,
  ProductServiceError,
  type ApproveProposalResult,
  type DashboardMetricsResult,
  type ExecutionStatusResult,
  type PrepareDraftApprovalResult,
  type ProductRequestContext,
  type ProductService,
} from './product-service.js';

const TENANT_ID = deterministicEvaluatorIdentityV2.tenantId;
const USER_ID = deterministicEvaluatorIdentityV2.userId;
const ACCOUNT_ID = deterministicEvaluatorIdentityV2.accountId;
const BRAND_ID = deterministicEvaluatorIdentityV2.brandId;
const ACCOUNT_IDS = deterministicEvaluatorIdentityV2.accountIds;
const BRAND_IDS = deterministicEvaluatorIdentityV2.brandIds;
const SEED_AT = '2026-07-17T12:00:00.000Z';
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';
const RECIPIENT_DIGEST = `h1_v1_${'A'.repeat(43)}`;
const RETRIEVAL_ROLE = 'factual';
const RETRIEVAL_SCORING_PROFILE = 'chief-bounded-fusion-v1';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function id(prefix: string, value: unknown): string {
  return `${prefix}_${canonicalSha256(value).slice(0, 40)}`;
}

function productUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/u, '')}${path}`;
}

export interface DurableRetrievalResult {
  readonly candidates: readonly RetrievalCandidate[];
  readonly citations: readonly Citation[];
  readonly snapshotManifestHash: string;
  readonly evidence: readonly {
    readonly chunkId: string;
    readonly citationId: string;
    readonly text: string;
    readonly exactEntityRefs?: readonly string[];
    readonly sourceClass?: DurableEvidenceSourceClass;
    readonly sourceAuthority?: DurableEvidenceSourceAuthority;
    readonly relation?: DurableEvidenceRelation;
  }[];
}

export interface DurableManifestBinding {
  readonly contractVersion: 'chief-validated-manifest-binding.v1';
  readonly tenantId: string;
  readonly scopeHash: string;
  readonly authorizationEpoch: number;
  readonly role: typeof RETRIEVAL_ROLE;
  readonly manifestHash: string;
  readonly scoringProfileVersion: typeof RETRIEVAL_SCORING_PROFILE;
  readonly records: readonly {
    readonly sourceId: string;
    readonly chunkId: string;
    readonly sourceVersion: string;
    readonly authorizationEpoch: number;
    readonly evidenceHash: string;
  }[];
}

export interface DurableRetrievalPort {
  search(
    context: ProductRequestContext,
    input: {
      readonly queryText: string;
      readonly exactEntityRefs: readonly string[];
      readonly limit: number;
    },
  ): Promise<DurableRetrievalResult>;
  verifyManifestBinding?(
    context: ProductRequestContext,
    binding: DurableManifestBinding,
    result: DurableRetrievalResult,
  ): Promise<boolean>;
}

export type DeterministicEvidenceTopic = 'release_readiness' | 'board_metrics';
export type DurableEvidenceTopic =
  DeterministicEvidenceTopic | 'event_logistics';
export type DurableEvidenceSourceClass =
  'communication' | 'organization_knowledge' | 'asana' | 'unclassified';
export type DurableEvidenceSourceAuthority =
  | {
      readonly contractVersion: 'chief-source-authority.v1';
      readonly verifiedBy: 'canonical_ingestion';
      readonly sourceClass: 'communication' | 'asana';
      readonly relationKind: 'canonical_thread' | 'explicit_related_work';
      readonly relationTopic?: DurableEvidenceTopic;
    }
  | {
      readonly contractVersion: 'legacy-unverified';
      readonly verifiedBy: 'none';
      readonly sourceClass: 'unclassified';
      readonly relationKind: 'unverified';
    };
export interface VerifiedEvidenceRelation {
  readonly verified: true;
  readonly kind:
    'canonical_message' | 'canonical_thread' | 'explicit_related_work';
  readonly topic: DeterministicEvidenceTopic;
  readonly exactEntityRefs: readonly string[];
}
export interface DurableEvidenceRelation {
  readonly verified: boolean;
  readonly kind:
    | 'canonical_message'
    | 'canonical_thread'
    | 'explicit_related_work'
    | 'unverified';
  readonly topic?: DurableEvidenceTopic;
  readonly exactEntityRefs: readonly string[];
}
export interface VerifiedDurableRetrievalResult extends Omit<
  DurableRetrievalResult,
  'evidence'
> {
  readonly evidence: readonly {
    readonly chunkId: string;
    readonly citationId: string;
    readonly text: string;
    readonly exactEntityRefs: readonly string[];
    readonly sourceClass: Exclude<DurableEvidenceSourceClass, 'unclassified'>;
    readonly relation: VerifiedEvidenceRelation;
  }[];
}
export interface VerifiedDurableRetrievalPort {
  search(
    context: ProductRequestContext,
    input: {
      readonly queryText: string;
      readonly exactEntityRefs: readonly string[];
      readonly limit: number;
    },
  ): Promise<VerifiedDurableRetrievalResult>;
}

function exactStringSetEquals(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === new Set(left).size &&
    right.length === new Set(right).size &&
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

function resolveRetrievedCitation(
  result: DurableRetrievalResult,
  citation: Citation,
): {
  readonly candidate: RetrievalCandidate;
  readonly evidence: DurableRetrievalResult['evidence'][number];
} | null {
  const candidates = result.candidates.filter(
    (candidate) =>
      candidate.chunkId === citation.chunkId &&
      candidate.sourceId === citation.sourceId &&
      candidate.authorizationEpoch === citation.hydratedUnderAuthorizationEpoch,
  );
  const evidence = result.evidence.filter(
    (item) =>
      item.chunkId === citation.chunkId &&
      item.citationId === citation.citationId,
  );
  if (
    !sha256Schema.safeParse(result.snapshotManifestHash).success ||
    candidates.length !== 1 ||
    evidence.length !== 1 ||
    citation.citationId !==
      `${citation.sourceId}:${citation.chunkId}:${citation.sourceVersion}` ||
    citation.contentHash !== sha256((evidence[0] as { text: string }).text)
  )
    return null;
  return {
    candidate: candidates[0] as RetrievalCandidate,
    evidence: evidence[0] as DurableRetrievalResult['evidence'][number],
  };
}

function manifestBinding(
  context: ProductRequestContext,
  result: DurableRetrievalResult,
): DurableManifestBinding | null {
  const scope = context.retrievalScope;
  if (
    scope === undefined ||
    !sha256Schema.safeParse(result.snapshotManifestHash).success ||
    result.candidates.length !== result.citations.length ||
    result.evidence.length !== result.citations.length
  )
    return null;
  const records = result.citations.map((citation) => {
    const resolved = resolveRetrievedCitation(result, citation);
    if (resolved === null) return null;
    return Object.freeze({
      sourceId: citation.sourceId,
      chunkId: citation.chunkId,
      sourceVersion: citation.sourceVersion,
      authorizationEpoch: citation.hydratedUnderAuthorizationEpoch,
      evidenceHash: sha256(resolved.evidence.text),
    });
  });
  if (
    records.some((record) => record === null) ||
    records.some(
      (record) => record?.authorizationEpoch !== scope.authorizationEpoch,
    ) ||
    new Set(records.map((record) => canonicalSha256(record))).size !==
      records.length
  )
    return null;
  return Object.freeze({
    contractVersion: 'chief-validated-manifest-binding.v1',
    tenantId: scope.tenantId,
    scopeHash: scope.scopeHash,
    authorizationEpoch: scope.authorizationEpoch,
    role: RETRIEVAL_ROLE,
    manifestHash: result.snapshotManifestHash,
    scoringProfileVersion: RETRIEVAL_SCORING_PROFILE,
    records: Object.freeze(
      (records as Exclude<(typeof records)[number], null>[]).sort(
        (left, right) =>
          left.sourceId.localeCompare(right.sourceId) ||
          left.chunkId.localeCompare(right.chunkId) ||
          left.sourceVersion.localeCompare(right.sourceVersion),
      ),
    ),
  });
}

async function assertTrustedManifest(
  retrieval: DurableRetrievalPort,
  context: ProductRequestContext,
  result: DurableRetrievalResult,
): Promise<void> {
  const binding = manifestBinding(context, result);
  if (
    binding === null ||
    retrieval.verifyManifestBinding === undefined ||
    !(await retrieval.verifyManifestBinding(context, binding, result))
  )
    throw new ProductServiceError(
      'STALE_REVISION',
      'Retrieval manifest lineage is not trusted.',
    );
}

function sourceOwnedMetadata(
  evidence: DurableRetrievalResult['evidence'][number],
  relation: {
    readonly exactEntityRef: string;
    readonly topic: DeterministicEvidenceTopic;
  },
): {
  readonly sourceClass: 'communication' | 'asana';
  readonly relation: VerifiedEvidenceRelation;
} | null {
  const authority = evidence.sourceAuthority;
  const suppliedRelation = evidence.relation;
  if (
    authority === undefined ||
    suppliedRelation === undefined ||
    authority.contractVersion !== 'chief-source-authority.v1' ||
    authority.verifiedBy !== 'canonical_ingestion' ||
    authority.sourceClass !== evidence.sourceClass ||
    authority.relationKind !== suppliedRelation.kind ||
    authority.relationTopic !== relation.topic ||
    suppliedRelation.verified !== true ||
    suppliedRelation.topic !== relation.topic ||
    !suppliedRelation.exactEntityRefs.includes(relation.exactEntityRef)
  )
    return null;
  if (
    (authority.sourceClass === 'communication' &&
      authority.relationKind !== 'canonical_thread') ||
    (authority.sourceClass === 'asana' &&
      authority.relationKind !== 'explicit_related_work')
  )
    return null;
  return {
    sourceClass: authority.sourceClass,
    relation: Object.freeze(suppliedRelation) as VerifiedEvidenceRelation,
  };
}

function verifiedEvaluatorRetrieval(
  retrieval: DurableRetrievalPort,
  relation: {
    readonly exactEntityRef: string;
    readonly topic: DeterministicEvidenceTopic;
  },
): VerifiedDurableRetrievalPort {
  return {
    search: async (context, input) => {
      const result = await retrieval.search(context, input);
      await assertTrustedManifest(retrieval, context, result);
      const verifiedEvidence: VerifiedDurableRetrievalResult['evidence'][number][] =
        [];
      const verifiedCitations: Citation[] = [];
      const verifiedCandidates: RetrievalCandidate[] = [];
      for (const citation of result.citations) {
        const resolved = resolveRetrievedCitation(result, citation);
        if (resolved === null) continue;
        const { candidate, evidence } = resolved;
        const metadata = sourceOwnedMetadata(evidence, relation);
        if (
          metadata === null ||
          metadata.relation.topic !== relation.topic ||
          !metadata.relation.exactEntityRefs.includes(relation.exactEntityRef)
        )
          continue;
        verifiedEvidence.push(
          Object.freeze({
            chunkId: evidence.chunkId,
            citationId: evidence.citationId,
            text: evidence.text,
            exactEntityRefs: Object.freeze([
              ...metadata.relation.exactEntityRefs,
            ]),
            sourceClass: metadata.sourceClass,
            relation: metadata.relation,
          }),
        );
        verifiedCitations.push(citation);
        verifiedCandidates.push(candidate);
      }
      return Object.freeze({
        candidates: Object.freeze(verifiedCandidates),
        citations: Object.freeze(verifiedCitations),
        snapshotManifestHash: result.snapshotManifestHash,
        evidence: Object.freeze(verifiedEvidence),
      });
    },
  };
}

export interface OperationQueue {
  enqueue(operationId: string): Promise<void>;
}

interface SeedProjection {
  readonly communications: readonly CommunicationSummaryView[];
  readonly details: readonly CommunicationDetailView[];
  readonly connectors: readonly ConnectorStatusView[];
  readonly channelByThread: Readonly<Record<string, string>>;
  readonly marker: HostedProjectionMarkerV2;
}

interface HostedProjectionMarkerV2 {
  readonly schemaVersion: '1';
  readonly projectionVersion: 'chief-hosted-projection.v2';
  readonly corpusHash: string;
  readonly generatedAt: string;
  readonly messageCount: 1_120;
  readonly threadCount: 160;
  readonly channelCount: 7;
  readonly accountCount: 7;
  readonly brandCount: 2;
}

interface StoredDraft {
  readonly artifact: DraftArtifact;
  readonly recommendationId: string;
}

interface StoredProposal {
  readonly proposalId: string;
  readonly draftRevisionId: string;
  readonly actionPlan: ActionPlan;
  readonly status: 'pending_approval' | 'approved';
  readonly approvalUrl: string;
  readonly updatedAt: string;
  readonly approvalId?: string;
  readonly operationId?: string;
  readonly receipt?: ApproveProposalResult['receipt'];
  readonly approvedFromUpdatedAt?: string;
}

interface StoredProposalIndex {
  readonly schemaVersion: '1';
  readonly proposalIds: readonly string[];
}

const PROPOSAL_INDEX_ID = 'public-evaluator';
const PROPOSAL_INDEX_WRITE_ATTEMPTS = 8;

function compareCommunicationChronology(
  left: CommunicationSummaryView,
  right: CommunicationSummaryView,
): number {
  return (
    left.sourceTimestamp.localeCompare(right.sourceTimestamp) ||
    left.revision - right.revision ||
    left.messageRevisionId.localeCompare(right.messageRevisionId)
  );
}

function readProposalIndex(value: unknown): readonly string[] {
  if (value === null || typeof value !== 'object')
    throw new ProductServiceError(
      'STALE_REVISION',
      'The durable proposal index is malformed.',
    );
  const candidate = value as Record<string, unknown>;
  const rawProposalIds = candidate.proposalIds;
  if (candidate.schemaVersion !== '1' || !Array.isArray(rawProposalIds))
    throw new ProductServiceError(
      'STALE_REVISION',
      'The durable proposal index is malformed.',
    );
  const proposalIds: string[] = [];
  for (const proposalId of rawProposalIds as unknown[]) {
    if (typeof proposalId !== 'string' || proposalId.length === 0)
      throw new ProductServiceError(
        'STALE_REVISION',
        'The durable proposal index is malformed.',
      );
    proposalIds.push(proposalId);
  }
  const normalized = [...proposalIds].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    new Set(normalized).size !== normalized.length ||
    canonicalSha256(normalized) !== canonicalSha256(proposalIds)
  )
    throw new ProductServiceError(
      'STALE_REVISION',
      'The durable proposal index is not canonical.',
    );
  return normalized;
}

function citation(
  sourceId: string,
  chunkId: string,
  label: string,
  evidenceText: string,
): Citation {
  return citationSchema.parse({
    citationId: `${sourceId}:${chunkId}:1`,
    sourceId,
    sourceVersion: '1',
    chunkId,
    label,
    contentHash: sha256(evidenceText),
    hydratedUnderAuthorizationEpoch: 1,
  });
}

const expectedChannelCounts = Object.freeze({
  gmail: 161,
  microsoft_graph: 161,
  sms: 161,
  whatsapp: 161,
  x: 161,
  linkedin_archive: 161,
  future_demo: 154,
});

const anchorByCorpusRevision = new Map<
  string,
  (typeof deterministicEvaluatorIdentityV2.anchorOverlays)[number]
>(
  deterministicEvaluatorIdentityV2.anchorOverlays.map((anchor) => [
    anchor.corpusMessageRevisionId,
    anchor,
  ]),
);

const anchorThreadByCorpusThread = new Map<string, string>(
  deterministicEvaluatorIdentityV2.anchorOverlays.map((anchor) => [
    anchor.corpusThreadId,
    anchor.productThreadAlias,
  ]),
);

function hostedAccountId(accountId: string): string {
  return accountId === 'account-tenant-demo-northstar-gmail-00'
    ? deterministicEvaluatorIdentityV2.accountId
    : accountId;
}

function hostedThreadId(threadId: string): string {
  return anchorThreadByCorpusThread.get(threadId) ?? threadId;
}

function connectorCapabilities(channel: string) {
  const email = channel === 'gmail' || channel === 'microsoft_graph';
  return {
    read: true,
    send: false,
    webhook: false,
    poll: false,
    threads: true,
    attachments: email,
    deliveryFeedback: false,
    multipleAccounts: true,
    historicalBackfill: true,
    externalEffect: false,
    replyCorrelation: true,
    complaintFeedback: false,
    unsubscribeFeedback: false,
    optOutFeedback: channel === 'sms' || channel === 'whatsapp',
    reconsentFeedback: false,
    consentWindowEligibility: channel === 'whatsapp',
  } as const;
}

function createSeed(baseUrl: string): SeedProjection {
  const corpus = resetDemoCorpus();
  if (
    corpus.manifest.corpusHash !==
      deterministicEvaluatorIdentityV2.corpus.corpusHash ||
    corpus.manifest.seed !== deterministicEvaluatorIdentityV2.corpus.seed ||
    corpus.manifest.generatedAt !==
      deterministicEvaluatorIdentityV2.corpus.generatedAt ||
    corpus.manifest.resetVersion !==
      deterministicEvaluatorIdentityV2.corpus.resetVersion ||
    corpus.manifest.syntheticOnly !== true
  )
    throw new ProductServiceError(
      'STALE_REVISION',
      'The deterministic evaluator corpus manifest drifted.',
    );

  const primaryTenant = deterministicEvaluatorIdentityV2.corpus.primaryTenantId;
  const revisions = new Map(
    corpus.messageRevisions
      .filter(({ tenantId }) => tenantId === primaryTenant)
      .map((revision) => [revision.revisionId, revision]),
  );
  const states = new Map(
    corpus.communicationStates
      .filter(({ tenantId }) => tenantId === primaryTenant)
      .map((state) => [state.messageRevisionId, state]),
  );
  const bodies = new Map(
    corpus.bodies
      .filter(
        ({ tenantId, classification }) =>
          tenantId === primaryTenant && classification === 'communication',
      )
      .map((body) => [body.sourceRef, body]),
  );
  const attachments = new Map(
    corpus.attachments
      .filter(({ tenantId }) => tenantId === primaryTenant)
      .map((attachment) => [attachment.attachmentId, attachment]),
  );
  const accounts = corpus.accounts.filter(
    ({ tenantId, channel }) =>
      tenantId === primaryTenant && channel !== 'asana',
  );
  const accountById = new Map(
    accounts.map((account) => [account.accountId, account]),
  );
  const channelCounts = new Map<string, number>();
  const channelByThread: Record<string, string> = {};
  const details: CommunicationDetailView[] = [];

  for (const message of corpus.messages.filter(
    ({ tenantId }) => tenantId === primaryTenant,
  )) {
    const revision = revisions.get(message.currentRevisionId);
    const state = states.get(message.currentRevisionId);
    if (revision === undefined || state === undefined)
      throw new ProductServiceError(
        'STALE_REVISION',
        'The deterministic evaluator communication projection is partial.',
      );
    const account = accountById.get(revision.connectorSnapshot.accountId);
    const body = bodies.get(revision.fullNormalizedBody.objectKey);
    if (account === undefined || body === undefined)
      throw new ProductServiceError(
        'STALE_REVISION',
        'The deterministic evaluator communication authority is partial.',
      );
    if (account.brandId === undefined)
      throw new ProductServiceError(
        'STALE_REVISION',
        'The deterministic evaluator communication brand authority is partial.',
      );
    const channel = account.channel;
    const accountId = hostedAccountId(account.accountId);
    const threadId = hostedThreadId(revision.threadId);
    const anchor = anchorByCorpusRevision.get(revision.revisionId);
    const messageId = anchor?.messageId ?? revision.messageId;
    const messageRevisionId = anchor?.messageRevisionId ?? revision.revisionId;
    const anchorBody =
      anchor === deterministicEvaluatorIdentityV2.anchorOverlays[0]
        ? 'Can we confirm the Friday launch and the owner for QA? The Friday launch decision is pending confirmation of the QA owner.'
        : anchor === deterministicEvaluatorIdentityV2.anchorOverlays[1]
          ? 'Please send the approved pipeline numbers for the board note.'
          : undefined;
    const normalizedBody = anchorBody ?? body.bodyText;
    const authoredText =
      anchorBody ?? revision.currentAuthoredSegment.authoredText;
    const subject =
      anchor === deterministicEvaluatorIdentityV2.anchorOverlays[0]
        ? 'Friday launch decision'
        : anchor === deterministicEvaluatorIdentityV2.anchorOverlays[1]
          ? 'Board update numbers'
          : revision.subject;
    const senderDisplayName =
      anchor === deterministicEvaluatorIdentityV2.anchorOverlays[0]
        ? 'Jordan Lee'
        : anchor === deterministicEvaluatorIdentityV2.anchorOverlays[1]
          ? 'Priya Shah'
          : revision.sender.displayName;
    const sourceTimestamp =
      anchor === deterministicEvaluatorIdentityV2.anchorOverlays[0]
        ? '2026-07-17T10:52:00.000Z'
        : anchor === deterministicEvaluatorIdentityV2.anchorOverlays[1]
          ? '2026-07-17T11:06:00.000Z'
          : revision.sourceTimestamp;
    const status =
      anchor === deterministicEvaluatorIdentityV2.anchorOverlays[0]
        ? 'overdue'
        : anchor === deterministicEvaluatorIdentityV2.anchorOverlays[1]
          ? 'pending'
          : state.responseStatus === 'no_action'
            ? 'resolved'
            : state.responseStatus;
    const summary = communicationSummaryViewSchema.parse({
      messageId,
      messageRevisionId,
      revision: 1,
      threadId,
      direction: revision.direction,
      status,
      channel,
      accountId,
      brandId: account.brandId,
      ...(senderDisplayName === undefined ? {} : { senderDisplayName }),
      recipientDisplayNames: revision.recipients.map(
        ({ displayName }) => displayName ?? 'Synthetic recipient',
      ),
      ...(subject === undefined ? {} : { subject }),
      excerpt: authoredText.slice(0, 1_000),
      attachmentCount:
        anchor === deterministicEvaluatorIdentityV2.anchorOverlays[0]
          ? 1
          : revision.attachmentIds.length,
      sourceTimestamp,
      productUrl: productUrl(
        baseUrl,
        `/communications/${encodeURIComponent(messageRevisionId)}`,
      ),
    });
    const viewAttachments =
      anchor === deterministicEvaluatorIdentityV2.anchorOverlays[0]
        ? [
            {
              attachmentId: 'attachment-launch-readiness',
              fileName: 'launch-readiness.pdf',
              mediaType: 'application/pdf',
              byteLength: 24_576,
              malwareState: 'clean' as const,
              productUrl: productUrl(
                baseUrl,
                '/attachments/attachment-launch-readiness',
              ),
            },
          ]
        : revision.attachmentIds.map((attachmentId) => {
            const attachment = attachments.get(attachmentId);
            if (attachment === undefined)
              throw new ProductServiceError(
                'STALE_REVISION',
                'The deterministic evaluator attachment projection is partial.',
              );
            return {
              attachmentId: attachment.attachmentId,
              fileName: attachment.fileName,
              mediaType: attachment.mediaType,
              byteLength: attachment.byteLength,
              malwareState: attachment.malwareState,
              productUrl: productUrl(
                baseUrl,
                `/attachments/${encodeURIComponent(attachment.attachmentId)}`,
              ),
            };
          });
    const sourceOrdinal =
      anchor === deterministicEvaluatorIdentityV2.anchorOverlays[0]
        ? '1'
        : anchor === deterministicEvaluatorIdentityV2.anchorOverlays[1]
          ? '2'
          : sha256(messageRevisionId).slice(0, 24);
    details.push(
      communicationDetailViewSchema.parse({
        ...summary,
        authoredText,
        normalizedText: normalizedBody,
        attachments: viewAttachments,
        citations: [
          citation(
            `source-communication-${sourceOrdinal}`,
            `chunk-communication-${sourceOrdinal}`,
            subject ?? `${channel} synthetic communication`,
            normalizedBody,
          ),
        ],
      }),
    );
    channelByThread[threadId] = channel;
    channelCounts.set(channel, (channelCounts.get(channel) ?? 0) + 1);
  }

  const anchorOrder = new Map(
    deterministicEvaluatorIdentityV2.anchorOverlays.map((anchor, index) => [
      anchor.messageRevisionId,
      index,
    ]),
  );
  details.sort((left, right) => {
    const leftAnchor = anchorOrder.get(left.messageRevisionId);
    const rightAnchor = anchorOrder.get(right.messageRevisionId);
    if (leftAnchor !== undefined || rightAnchor !== undefined)
      return (leftAnchor ?? 2) - (rightAnchor ?? 2);
    return (
      left.sourceTimestamp.localeCompare(right.sourceTimestamp) ||
      left.messageRevisionId.localeCompare(right.messageRevisionId)
    );
  });
  const communications = details.map(
    ({
      authoredText: _authored,
      normalizedText: _normalized,
      attachments: _attachments,
      citations: _citations,
      ...summary
    }) => communicationSummaryViewSchema.parse(summary),
  );
  const observedChannelCounts = Object.fromEntries(
    [...channelCounts.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const expectedSortedChannelCounts = Object.fromEntries(
    Object.entries(expectedChannelCounts).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  if (
    communications.length !==
      deterministicEvaluatorIdentityV2.corpus.messageCount ||
    new Set(communications.map(({ threadId }) => threadId)).size !==
      deterministicEvaluatorIdentityV2.corpus.threadCount ||
    accounts.length !== deterministicEvaluatorIdentityV2.corpus.accountCount ||
    new Set(accounts.map(({ brandId }) => brandId)).size !==
      deterministicEvaluatorIdentityV2.corpus.brandCount ||
    canonicalSha256(observedChannelCounts) !==
      canonicalSha256(expectedSortedChannelCounts) ||
    deterministicEvaluatorIdentityV2.anchorOverlays.some(
      ({ messageRevisionId }) =>
        !communications.some(
          (communication) =>
            communication.messageRevisionId === messageRevisionId,
        ),
    )
  )
    throw new ProductServiceError(
      'STALE_REVISION',
      'The deterministic evaluator corpus count or anchor contract drifted.',
    );

  const connectors = accounts.map((account) => {
    const accountId = hostedAccountId(account.accountId);
    const gmail = account.channel === 'gmail';
    return connectorStatusViewSchema.parse({
      accountId,
      brandId: account.brandId,
      connectorId: gmail
        ? deterministicEvaluatorIdentityV1.connector.connectorId
        : account.snapshot.connectorId,
      displayLabel: `${account.channel.replaceAll('_', ' ')} synthetic evaluator fixture`,
      provider: account.provider,
      connectorKind: 'communication',
      channel: account.channel,
      status: 'active',
      health: 'healthy',
      runtimeMode: gmail
        ? deterministicEvaluatorIdentityV1.connector.runtimeMode
        : account.snapshot.runtimeMode,
      selectionState: 'selected',
      capabilities: connectorCapabilities(account.channel),
      lastSyncAt: corpus.manifest.generatedAt,
      productUrl: productUrl(
        baseUrl,
        `/settings/connectors/${encodeURIComponent(account.snapshot.connectorId)}`,
      ),
    });
  });
  if (
    canonicalSha256(connectors.map(({ accountId }) => accountId)) !==
      canonicalSha256(ACCOUNT_IDS) ||
    connectors.some(
      ({ brandId }) => brandId === undefined || !BRAND_IDS.includes(brandId),
    )
  )
    throw new ProductServiceError(
      'STALE_REVISION',
      'The deterministic evaluator connector authority drifted.',
    );

  const marker = Object.freeze({
    schemaVersion: '1' as const,
    projectionVersion: 'chief-hosted-projection.v2' as const,
    corpusHash: deterministicEvaluatorIdentityV2.corpus.corpusHash,
    generatedAt: deterministicEvaluatorIdentityV2.corpus.generatedAt,
    messageCount: deterministicEvaluatorIdentityV2.corpus.messageCount,
    threadCount: deterministicEvaluatorIdentityV2.corpus.threadCount,
    channelCount: deterministicEvaluatorIdentityV2.corpus.channelCount,
    accountCount: deterministicEvaluatorIdentityV2.corpus.accountCount,
    brandCount: deterministicEvaluatorIdentityV2.corpus.brandCount,
  });
  return Object.freeze({
    communications: Object.freeze(communications),
    details: Object.freeze(details),
    connectors: Object.freeze(connectors),
    channelByThread: Object.freeze(channelByThread),
    marker,
  });
}

function encodeCursor(offset: number, binding: string): string {
  return Buffer.from(
    JSON.stringify({ version: 2, offset, binding }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor: string | undefined, binding: string): number {
  if (cursor === undefined) return 0;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { version?: unknown; offset?: unknown; binding?: unknown };
    if (
      value.version !== 2 ||
      value.binding !== binding ||
      !Number.isSafeInteger(value.offset) ||
      Number(value.offset) < 0
    )
      throw new Error('bad');
    return Number(value.offset);
  } catch {
    throw new ProductServiceError('BAD_CURSOR', 'The cursor is invalid.');
  }
}

function communicationListBinding(input: {
  readonly status?: string;
  readonly query?: string;
  readonly channel?: string;
  readonly accountFilter?: string;
  readonly brandFilter?: string;
}): string {
  return canonicalSha256({
    status: input.status ?? null,
    query: input.query?.trim().toLocaleLowerCase('en-US') ?? null,
    channel: input.channel ?? null,
    accountFilter: input.accountFilter ?? null,
    brandFilter: input.brandFilter ?? null,
  });
}

function evaluatorTopicForMessage(
  messageRevisionId: string,
): DeterministicEvidenceTopic | null {
  if (
    messageRevisionId ===
    deterministicEvaluatorIdentityV2.anchorOverlays[0].messageRevisionId
  )
    return 'release_readiness';
  if (
    messageRevisionId ===
    deterministicEvaluatorIdentityV2.anchorOverlays[1].messageRevisionId
  )
    return 'board_metrics';
  return null;
}

export class DurableProductService implements ProductService {
  readonly #seed: SeedProjection;

  public constructor(
    private readonly repository: DurableProductRepository,
    private readonly retrieval: DurableRetrievalPort,
    private readonly baseUrl: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly operationQueue?: OperationQueue,
  ) {
    this.#seed = createSeed(baseUrl);
  }

  async #projection(context: ProductRequestContext): Promise<SeedProjection> {
    this.#assertContext(context);
    const existing = await this.repository.getCurrent<HostedProjectionMarkerV2>(
      TENANT_ID,
      'hosted-projection-marker',
      'public-evaluator-v2',
    );
    if (existing === undefined) {
      try {
        await this.repository.putRevision(TENANT_ID, {
          entityType: 'hosted-projection-marker',
          entityId: 'public-evaluator-v2',
          revisionId: 'hosted-projection-marker-v2',
          version: 1,
          committedAt: deterministicEvaluatorIdentityV2.corpus.generatedAt,
          value: this.#seed.marker,
        });
      } catch (error) {
        if (!(error instanceof PersistenceConflictError)) throw error;
      }
    }
    const persisted =
      existing ??
      (await this.repository.getCurrent<HostedProjectionMarkerV2>(
        TENANT_ID,
        'hosted-projection-marker',
        'public-evaluator-v2',
      ));
    if (
      persisted === undefined ||
      canonicalSha256(persisted.value) !== canonicalSha256(this.#seed.marker)
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'The durable evaluator corpus marker is partial or drifted.',
      );
    return this.#seed;
  }

  #assertContext(context: ProductRequestContext): void {
    const safe = serverRequestContextSchema.parse(context);
    const scope = safe.retrievalScope;
    if (
      safe.actor.tenantId !== TENANT_ID ||
      safe.actor.userId !== USER_ID ||
      scope === undefined ||
      scope.tenantId !== TENANT_ID ||
      scope.authorizationEpoch !==
        deterministicEvaluatorIdentityV2.authorizationEpoch ||
      scope.scopeHash !== deterministicEvaluatorIdentityV2.scopeHash ||
      !exactStringSetEquals(safe.actor.accountScopes, ACCOUNT_IDS) ||
      !exactStringSetEquals(safe.actor.brandScopes, BRAND_IDS) ||
      !exactStringSetEquals(scope.accountIds, safe.actor.accountScopes) ||
      !exactStringSetEquals(scope.brandIds, safe.actor.brandScopes) ||
      !safe.actor.grants.includes('communications:read') ||
      !safe.actor.grants.includes('knowledge:read') ||
      !safe.actor.grants.includes('actions:approve') ||
      !safe.actor.grants.includes('actions:prepare')
    ) {
      throw new ProductServiceError(
        'FORBIDDEN_AUTHORITY',
        'The fixed evaluator authority is required.',
      );
    }
  }

  #sourceForRecommendation(artifact: RecommendationArtifact): {
    readonly detail: CommunicationDetailView;
    readonly exactEntityRef: string;
    readonly topic: DeterministicEvidenceTopic;
  } {
    const sourceMessageRevisionId =
      artifact.recommendation.sourceMessageRevisionId;
    const detail = this.#seed.details.find(
      ({ messageRevisionId }) => messageRevisionId === sourceMessageRevisionId,
    );
    const identity = deterministicEvaluatorIdentityV2.anchorOverlays.find(
      ({ messageRevisionId }) => messageRevisionId === sourceMessageRevisionId,
    );
    const topic = evaluatorTopicForMessage(sourceMessageRevisionId);
    if (detail === undefined || identity === undefined || topic === null)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Recommendation source communication was not found.',
      );
    return {
      detail,
      exactEntityRef: identity.retrievalExactEntityRef,
      topic,
    };
  }

  async #assertRecommendationLineage(
    context: ProductRequestContext,
    artifact: RecommendationArtifact,
  ): Promise<void> {
    const source = this.#sourceForRecommendation(artifact);
    const result = await verifiedEvaluatorRetrieval(this.retrieval, {
      exactEntityRef: source.exactEntityRef,
      topic: source.topic,
    }).search(context, {
      queryText:
        `${source.detail.subject ?? ''}\n${source.detail.authoredText}`.trim(),
      exactEntityRefs: [source.exactEntityRef],
      limit: 8,
    });
    const expectedContextManifestHash = immutableHash(
      ['communication', 'organization_knowledge', 'asana'].map((kind) => ({
        kind,
        snapshotManifestHash: result.snapshotManifestHash,
      })),
    );
    const citationsById = new Map(
      result.citations.map((citation) => [citation.citationId, citation]),
    );
    const evidenceByCitation = new Map(
      result.evidence.map((evidence) => [evidence.citationId, evidence]),
    );
    const contextCitations = artifact.context.facts.map(({ citation }) =>
      canonicalSha256(citation),
    );
    const trusted =
      artifact.context.snapshotManifestHash === expectedContextManifestHash &&
      canonicalSha256(artifact.context.citations) ===
        canonicalSha256(artifact.recommendation.citations) &&
      canonicalSha256(artifact.recommendation.citations) ===
        canonicalSha256(
          artifact.context.facts.map(({ citation }) => citation),
        ) &&
      contextCitations.length === new Set(contextCitations).size &&
      artifact.context.facts.every((fact) => {
        const citation = citationsById.get(fact.citation.citationId);
        const evidence = evidenceByCitation.get(fact.citation.citationId);
        return (
          citation !== undefined &&
          evidence !== undefined &&
          canonicalSha256(citation) === canonicalSha256(fact.citation) &&
          evidence.text === fact.statement &&
          evidence.sourceClass === fact.sourceKind
        );
      });
    if (!trusted)
      throw new ProductServiceError(
        'STALE_REVISION',
        'Persisted recommendation citation lineage is no longer trusted.',
      );
  }

  #assertDraftLineage(
    stored: StoredDraft,
    recommendation: RecommendationArtifact,
  ): void {
    if (
      stored.recommendationId !==
        recommendation.recommendation.recommendationId ||
      stored.artifact.recommendationHash !== recommendation.immutableHash ||
      canonicalSha256(stored.artifact.context) !==
        canonicalSha256(recommendation.context) ||
      canonicalSha256(stored.artifact.result.draft.citations) !==
        canonicalSha256(recommendation.recommendation.citations)
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'Persisted draft citation lineage is no longer trusted.',
      );
  }

  async #assertCurrentDraftHead(
    stored: StoredDraft,
  ): Promise<AtomicCurrentHeadCondition> {
    const draft = stored.artifact.result.draft;
    const current = await this.repository.getCurrent<StoredDraft>(
      TENANT_ID,
      'draft',
      draft.draftId,
    );
    if (
      current === undefined ||
      current.entityType !== 'draft' ||
      current.entityId !== draft.draftId ||
      current.revisionId !== draft.draftRevisionId ||
      current.version !== draft.revision ||
      canonicalSha256(current.value) !== canonicalSha256(stored)
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'The requested draft revision is not the current durable head.',
      );
    await this.#assertExactDraftLookup(current.value);
    return Object.freeze({
      entityType: 'draft',
      entityId: draft.draftId,
      revisionId: draft.draftRevisionId,
      version: draft.revision,
    });
  }

  async #assertProposalLineage(
    context: ProductRequestContext,
    proposal: StoredProposal,
  ): Promise<AtomicCurrentHeadCondition> {
    const storedDraft = await this.repository.getExact<StoredDraft>(
      TENANT_ID,
      'draft-revision',
      proposal.draftRevisionId,
    );
    if (storedDraft === undefined)
      throw new ProductServiceError(
        'STALE_REVISION',
        'Persisted proposal draft lineage is no longer available.',
      );
    const expectedDraftHead = await this.#assertCurrentDraftHead(
      storedDraft.value,
    );
    const recommendation =
      await this.repository.getCurrent<RecommendationArtifact>(
        TENANT_ID,
        'recommendation',
        storedDraft.value.recommendationId,
      );
    if (recommendation === undefined)
      throw new ProductServiceError(
        'STALE_REVISION',
        'Persisted proposal recommendation lineage is no longer available.',
      );
    await this.#assertRecommendationLineage(context, recommendation.value);
    this.#assertDraftLineage(storedDraft.value, recommendation.value);
    const source = this.#sourceForRecommendation(recommendation.value);
    const expectedActionPlan = createDeterministicDurableAgent({
      repository: this.repository,
      retrieval: verifiedEvaluatorRetrieval(this.retrieval, {
        exactEntityRef: source.exactEntityRef,
        topic: source.topic,
      }),
      context,
      now: this.now,
      authorizedTopic: source.topic,
    }).prepareApprovalActionPlan({
      artifact: storedDraft.value.artifact,
      policyVersion: 'effect-disabled-v1',
      expiresAt: EXPIRES_AT,
    });
    if (
      proposal.proposalId !==
        id('proposal', {
          actionPlanId: expectedActionPlan.actionPlanId,
          revision: 1,
        }) ||
      canonicalSha256(proposal.actionPlan) !==
        canonicalSha256(expectedActionPlan)
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'Persisted proposal action-plan lineage is no longer trusted.',
      );
    return expectedDraftHead;
  }

  public async dashboardMetrics(
    context: ProductRequestContext,
    input: { readonly window: '24h' | '7d' | '30d' },
  ): Promise<DashboardMetricsResult> {
    const projection = await this.#projection(context);
    const snapshot = (await this.getSlaMetrics(context, input)).snapshot;
    return dashboardMetricsResultSchema.parse({
      snapshot,
      totalCommunications: projection.communications.length,
      pendingApprovalCount: await this.#pendingApprovalCount(context),
      channelBreakdown: Object.entries(expectedChannelCounts).map(
        ([channel, count]) => ({ channel, count }),
      ),
    });
  }

  public async getSlaMetrics(
    context: ProductRequestContext,
    input: { readonly window: '24h' | '7d' | '30d' },
  ) {
    const projection = await this.#projection(context);
    const count = (status: string) =>
      projection.communications.filter((item) => item.status === status).length;
    return getSlaMetricsResultSchema.parse({
      snapshot: {
        schemaVersion: '1',
        window: input.window,
        measuredAt: SEED_AT,
        pendingCount: count('pending'),
        overdueCount: count('overdue'),
        answeredCount: count('answered'),
        resolvedCount: count('resolved'),
        responseTimeP50Ms: 42_000,
        responseTimeP95Ms: 118_000,
        ingestionLagP95Ms: 24_000,
      },
    });
  }

  public async listCommunications(
    context: ProductRequestContext,
    input: {
      readonly status?: 'pending' | 'answered' | 'overdue' | 'resolved';
      readonly query?: string;
      readonly channel?: string;
      readonly accountFilter?: string;
      readonly brandFilter?: string;
      readonly limit: number;
      readonly cursor?: string;
    },
  ) {
    const projection = await this.#projection(context);
    const normalizedQuery = input.query?.trim().toLocaleLowerCase('en-US');
    const all = projection.communications.filter((communication) => {
      if (input.status !== undefined && communication.status !== input.status)
        return false;
      if (
        input.channel !== undefined &&
        communication.channel !== input.channel
      )
        return false;
      if (
        input.accountFilter !== undefined &&
        communication.accountId !== input.accountFilter
      )
        return false;
      if (
        input.brandFilter !== undefined &&
        communication.brandId !== input.brandFilter
      )
        return false;
      if (normalizedQuery === undefined) return true;
      return [
        communication.senderDisplayName,
        ...communication.recipientDisplayNames,
        communication.subject,
        communication.excerpt,
        communication.channel,
        communication.accountId,
        communication.brandId,
      ].some((value) =>
        value?.toLocaleLowerCase('en-US').includes(normalizedQuery),
      );
    });
    const binding = communicationListBinding(input);
    const offset = decodeCursor(input.cursor, binding);
    if (offset > all.length)
      throw new ProductServiceError(
        'BAD_CURSOR',
        'The cursor is past the filtered communication result set.',
      );
    const items = all.slice(offset, offset + input.limit);
    const next = offset + items.length;
    return listCommunicationsResultSchema.parse({
      items,
      totalCount: all.length,
      ...(next < all.length ? { nextCursor: encodeCursor(next, binding) } : {}),
    });
  }

  public async getCommunication(
    context: ProductRequestContext,
    input: { readonly messageRevisionId: string },
  ) {
    const projection = await this.#projection(context);
    const communication = projection.details.find(
      ({ messageRevisionId }) => messageRevisionId === input.messageRevisionId,
    );
    if (communication === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Communication was not found.',
      );
    return getCommunicationResultSchema.parse({ communication });
  }

  public async getThreadContext(
    context: ProductRequestContext,
    input: {
      readonly threadId: string;
      readonly limit: number;
      readonly cursor?: string;
    },
  ) {
    const projection = await this.#projection(context);
    const all = projection.communications
      .filter(({ threadId }) => threadId === input.threadId)
      .sort(compareCommunicationChronology);
    if (all.length === 0)
      throw new ProductServiceError('NOT_FOUND', 'Thread was not found.');
    const offset = decodeCursor(input.cursor, `thread:${input.threadId}`);
    const communications = all.slice(offset, offset + input.limit);
    const latest = all.at(-1) as CommunicationSummaryView;
    const thread = threadContextViewSchema.parse({
      threadId: input.threadId,
      channel: projection.channelByThread[input.threadId] ?? 'unknown',
      subject: all[0]?.subject,
      participantDisplayNames: ['Public evaluator'],
      status: 'active',
      latestMessageRevisionId: latest.messageRevisionId,
      sourceUpdatedAt: latest.sourceTimestamp,
      communications,
      productUrl: productUrl(this.baseUrl, `/threads/${input.threadId}`),
    });
    return getThreadContextResultSchema.parse({ thread });
  }

  public async getConnectorStatus(
    context: ProductRequestContext,
    input: { readonly connectorId?: string },
  ) {
    const projection = await this.#projection(context);
    return getConnectorStatusResultSchema.parse({
      connectors:
        input.connectorId === undefined
          ? projection.connectors
          : projection.connectors.filter(
              ({ connectorId }) => connectorId === input.connectorId,
            ),
    });
  }

  public async getRelatedAsanaWork(
    context: ProductRequestContext,
    input: { readonly messageRevisionId: string; readonly limit: number },
  ) {
    await this.getCommunication(context, input);
    return getRelatedAsanaWorkResultSchema.parse({ items: [] });
  }

  public async searchKnowledge(
    context: ProductRequestContext,
    input: {
      readonly queryText: string;
      readonly exactEntityRefs: readonly string[];
      readonly limit: number;
    },
  ) {
    this.#assertContext(context);
    const result = await this.retrieval.search(context, input);
    await assertTrustedManifest(this.retrieval, context, result);
    const resolved = result.citations
      .map((item) => {
        const record = resolveRetrievedCitation(result, item);
        const topic = record?.evidence.relation?.topic;
        const exactEntityRef = input.exactEntityRefs.find((reference) =>
          record?.evidence.relation?.exactEntityRefs.includes(reference),
        );
        const sourceOwned =
          record !== null &&
          exactEntityRef !== undefined &&
          (topic === 'release_readiness' || topic === 'board_metrics')
            ? sourceOwnedMetadata(record.evidence, {
                exactEntityRef,
                topic,
              })
            : null;
        return { citation: item, record, sourceOwned };
      })
      .filter(
        (
          item,
        ): item is {
          citation: Citation;
          record: NonNullable<typeof item.record>;
          sourceOwned: NonNullable<typeof item.sourceOwned>;
        } => item.record !== null && item.sourceOwned !== null,
      );
    return searchKnowledgeResultSchema.parse({
      candidates: resolved.map(({ record }) => record.candidate),
      citations: resolved.map(({ citation }) => citation),
    });
  }

  public async recommendAction(
    context: ProductRequestContext,
    input: {
      readonly messageRevisionId: string;
      readonly expectedMessageRevision: number;
    },
  ) {
    const detail = (await this.getCommunication(context, input)).communication;
    if (detail.revision !== input.expectedMessageRevision)
      throw new ProductServiceError(
        'STALE_REVISION',
        'Communication revision is stale.',
      );
    const communicationIdentity =
      deterministicEvaluatorIdentityV2.anchorOverlays.find(
        ({ messageRevisionId }) =>
          messageRevisionId === detail.messageRevisionId,
      );
    if (communicationIdentity === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Evaluator communication identity was not found.',
      );
    const topic = evaluatorTopicForMessage(detail.messageRevisionId);
    if (topic === null)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Evaluator communication topic was not found.',
      );
    const agent = createDeterministicDurableAgent({
      repository: this.repository,
      retrieval: verifiedEvaluatorRetrieval(this.retrieval, {
        exactEntityRef: communicationIdentity.retrievalExactEntityRef,
        topic,
      }),
      context,
      now: this.now,
      authorizedTopic: topic,
    });
    const artifact = await agent.recommend({
      tenantId: TENANT_ID,
      userId: USER_ID,
      brandId: BRAND_ID,
      sourceMessageRevisionId: detail.messageRevisionId,
      sourceMessageRevision: detail.revision,
      channel: 'email',
      subject: detail.subject,
      authoredText: detail.authoredText,
      scopeHash: context.retrievalScope?.scopeHash ?? sha256('missing-scope'),
      exactEntityRefs: [communicationIdentity.retrievalExactEntityRef],
      styleExamples: [
        {
          exampleId: 'approved-style-example-1',
          tenantId: TENANT_ID,
          userId: USER_ID,
          brandId: BRAND_ID,
          channel: 'email',
          body: 'Hi,\n\nThanks for the note. I will confirm today.\n\nThanks,',
          approvedAt: SEED_AT,
          approved: true,
        },
      ],
    });
    const recommendation = artifact.recommendation;
    const existing = await this.repository.getCurrent<RecommendationArtifact>(
      TENANT_ID,
      'recommendation',
      recommendation.recommendationId,
    );
    if (existing !== undefined) {
      await this.#assertRecommendationLineage(context, existing.value);
      if (existing.value.immutableHash !== artifact.immutableHash)
        throw new ProductServiceError(
          'STALE_REVISION',
          'Recommendation replay conflicts with durable state.',
        );
      return { recommendation: existing.value.recommendation };
    }
    try {
      await this.repository.putRevision(TENANT_ID, {
        entityType: 'recommendation',
        entityId: recommendation.recommendationId,
        revisionId: `${recommendation.recommendationId}:1`,
        version: 1,
        committedAt: recommendation.createdAt,
        value: artifact,
      });
    } catch (error) {
      if (!(error instanceof PersistenceConflictError)) throw error;
    }
    const persisted = await this.repository.getCurrent<RecommendationArtifact>(
      TENANT_ID,
      'recommendation',
      recommendation.recommendationId,
    );
    if (
      persisted === undefined ||
      persisted.value.immutableHash !== artifact.immutableHash
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'Recommendation write conflicted with durable state.',
      );
    return { recommendation: persisted.value.recommendation };
  }

  public async createDraft(
    context: ProductRequestContext,
    input: {
      readonly recommendationId: string;
      readonly expectedRecommendationRevision: number;
    },
  ) {
    this.#assertContext(context);
    const stored = await this.repository.getCurrent<RecommendationArtifact>(
      TENANT_ID,
      'recommendation',
      input.recommendationId,
    );
    if (stored === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Recommendation was not found.',
      );
    if (
      stored.value.recommendation.revision !==
      input.expectedRecommendationRevision
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'Recommendation revision is stale.',
      );
    await this.#assertRecommendationLineage(context, stored.value);
    const source = this.#sourceForRecommendation(stored.value);
    const draftId = deterministicId('draft', {
      recommendationId: input.recommendationId,
      connectorAccountId: ACCOUNT_ID,
    });
    const currentDraft = await this.repository.getCurrent<StoredDraft>(
      TENANT_ID,
      'draft',
      draftId,
    );
    if (currentDraft !== undefined) {
      if (currentDraft.value.recommendationId !== input.recommendationId)
        throw new ProductServiceError(
          'STALE_REVISION',
          'The persisted draft binding conflicts with the recommendation.',
        );
      await this.#assertExactDraftLookup(currentDraft.value);
      this.#assertDraftLineage(currentDraft.value, stored.value);
      return { result: currentDraft.value.artifact.result };
    }
    const outcome = await createDeterministicDurableAgent({
      repository: this.repository,
      retrieval: verifiedEvaluatorRetrieval(this.retrieval, {
        exactEntityRef: source.exactEntityRef,
        topic: source.topic,
      }),
      context,
      now: this.now,
      authorizedTopic: source.topic,
    }).createDraft({
      recommendation: stored.value,
      expectedRecommendationRevision: input.expectedRecommendationRevision,
      connectorAccountId: ACCOUNT_ID,
      recipientDigests: [RECIPIENT_DIGEST as never],
      subject: source.detail.subject ?? 'Communication reply',
    });
    if (outcome.kind !== 'ready')
      throw new ProductServiceError(
        'INVALID_INPUT',
        `Draft preparation ${outcome.kind}.`,
      );
    try {
      const persisted = await this.#persistDraft(
        outcome.artifact,
        input.recommendationId,
      );
      return { result: persisted.artifact.result };
    } catch (error) {
      if (!(error instanceof PersistenceConflictError)) throw error;
      const winner = await this.repository.getCurrent<StoredDraft>(
        TENANT_ID,
        'draft',
        draftId,
      );
      if (winner?.value.recommendationId === input.recommendationId) {
        this.#assertDraftLineage(winner.value, stored.value);
        return { result: winner.value.artifact.result };
      }
      throw new ProductServiceError(
        'STALE_REVISION',
        'Draft creation conflicted with a newer durable head.',
      );
    }
  }

  async #persistDraft(
    artifact: DraftArtifact,
    recommendationId: string,
  ): Promise<StoredDraft> {
    const draft = artifact.result.draft;
    const current = await this.repository.getCurrent<StoredDraft>(
      TENANT_ID,
      'draft',
      draft.draftId,
    );
    const value = { artifact, recommendationId } satisfies StoredDraft;
    await this.repository.putRevisionWithExactLookup(TENANT_ID, {
      revision: {
        entityType: 'draft',
        entityId: draft.draftId,
        revisionId: draft.draftRevisionId,
        version: draft.revision,
        committedAt: draft.createdAt,
        ...(current === undefined
          ? {}
          : {
              expectedVersion: current.version,
              expectedRevisionId: current.revisionId,
            }),
        value,
      },
      exactLookup: {
        entityType: 'draft-revision',
        entityId: draft.draftRevisionId,
        revisionId: draft.draftRevisionId,
        version: draft.revision,
        committedAt: draft.createdAt,
        value,
      },
    });
    const persisted = await this.repository.getCurrent<StoredDraft>(
      TENANT_ID,
      'draft',
      draft.draftId,
    );
    if (
      persisted === undefined ||
      persisted.revisionId !== draft.draftRevisionId ||
      persisted.value.recommendationId !== recommendationId
    )
      throw new PersistenceConflictError();
    await this.#assertExactDraftLookup(persisted.value);
    return persisted.value;
  }

  async #assertExactDraftLookup(stored: StoredDraft): Promise<void> {
    const draft = stored.artifact.result.draft;
    const exact = await this.repository.getExact<StoredDraft>(
      TENANT_ID,
      'draft-revision',
      draft.draftRevisionId,
    );
    if (
      exact === undefined ||
      exact.revisionId !== draft.draftRevisionId ||
      exact.version !== draft.revision ||
      exact.value.recommendationId !== stored.recommendationId ||
      exact.value.artifact.immutableHash !== stored.artifact.immutableHash
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'The durable draft head has no matching immutable revision lookup.',
      );
  }

  public async reviseDraft(
    context: ProductRequestContext,
    input: {
      readonly draftRevisionId: string;
      readonly expectedDraftRevision: number;
      readonly revisionInstruction: string;
    },
  ) {
    this.#assertContext(context);
    const stored = await this.repository.getExact<StoredDraft>(
      TENANT_ID,
      'draft-revision',
      input.draftRevisionId,
    );
    if (stored === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Draft revision was not found.',
      );
    if (
      stored.value.artifact.result.draft.revision !==
      input.expectedDraftRevision
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'Draft revision is stale.',
      );
    const recommendation =
      await this.repository.getCurrent<RecommendationArtifact>(
        TENANT_ID,
        'recommendation',
        stored.value.recommendationId,
      );
    if (recommendation === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Recommendation was not found.',
      );
    await this.#assertRecommendationLineage(context, recommendation.value);
    this.#assertDraftLineage(stored.value, recommendation.value);
    const source = this.#sourceForRecommendation(recommendation.value);
    const outcome = await createDeterministicDurableAgent({
      repository: this.repository,
      retrieval: verifiedEvaluatorRetrieval(this.retrieval, {
        exactEntityRef: source.exactEntityRef,
        topic: source.topic,
      }),
      context,
      now: this.now,
      authorizedTopic: source.topic,
    }).reviseDraft({
      recommendation: recommendation.value,
      expectedRecommendationRevision:
        recommendation.value.recommendation.revision,
      connectorAccountId: ACCOUNT_ID,
      recipientDigests: [RECIPIENT_DIGEST as never],
      subject: source.detail.subject ?? 'Communication reply',
      base: stored.value.artifact,
      expectedDraftRevision: input.expectedDraftRevision,
      revisionInstruction: input.revisionInstruction,
    });
    if (outcome.kind !== 'ready')
      throw new ProductServiceError(
        'INVALID_INPUT',
        `Draft revision ${outcome.kind}.`,
      );
    try {
      const persisted = await this.#persistDraft(
        outcome.artifact,
        stored.value.recommendationId,
      );
      return { result: persisted.artifact.result };
    } catch (error) {
      if (error instanceof PersistenceConflictError)
        throw new ProductServiceError(
          'STALE_REVISION',
          'Draft revision conflicted with a newer durable head.',
        );
      throw error;
    }
  }

  public async requestContext(
    context: ProductRequestContext,
    input: {
      readonly recommendationId: string;
      readonly expectedRecommendationRevision: number;
      readonly focusedQuestion?: string;
    },
  ) {
    this.#assertContext(context);
    const stored = await this.repository.getCurrent<RecommendationArtifact>(
      TENANT_ID,
      'recommendation',
      input.recommendationId,
    );
    if (stored === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Recommendation was not found.',
      );
    if (
      stored.value.recommendation.revision !==
      input.expectedRecommendationRevision
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'Recommendation revision is stale.',
      );
    await this.#assertRecommendationLineage(context, stored.value);
    return {
      request: contextRequestSchema.parse({
        schemaVersion: '1',
        tenantId: TENANT_ID,
        contextRequestId: id('context', input.recommendationId),
        recommendationId: input.recommendationId,
        focusedQuestion:
          input.focusedQuestion ??
          'Which approved fact should determine the response?',
        missingFacts:
          stored.value.recommendation.missingFacts.length > 0
            ? stored.value.recommendation.missingFacts
            : ['user confirmation'],
        state: 'open',
        responseEvidenceRefs: [],
        createdAt: this.now(),
      }),
    };
  }

  public prepareApproval(): never {
    throw new ProductServiceError(
      'INVALID_INPUT',
      'Prepare approval from a persisted draft revision with approvals.prepareDraft.',
    );
  }

  public async prepareAsanaAction(
    context: ProductRequestContext,
    input: {
      readonly recommendationId: string;
      readonly expectedRecommendationRevision: number;
    },
  ) {
    this.#assertContext(context);
    const recommendation =
      await this.repository.getCurrent<RecommendationArtifact>(
        TENANT_ID,
        'recommendation',
        input.recommendationId,
      );
    if (recommendation === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Recommendation was not found.',
      );
    if (
      recommendation.value.recommendation.revision !==
      input.expectedRecommendationRevision
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'Recommendation revision is stale.',
      );
    await this.#assertRecommendationLineage(context, recommendation.value);
    return proposalHandoffSchema.parse({
      proposalId: id('proposal-asana', input.recommendationId),
      approvalUrl: productUrl(this.baseUrl, '/approvals'),
      status: 'prepared',
      directEffectAvailable: false,
    });
  }

  public async prepareDraftApproval(
    context: ProductRequestContext,
    input: {
      readonly draftRevisionId: string;
      readonly expectedDraftRevision: number;
    },
  ): Promise<PrepareDraftApprovalResult> {
    this.#assertContext(context);
    const stored = await this.repository.getExact<StoredDraft>(
      TENANT_ID,
      'draft-revision',
      input.draftRevisionId,
    );
    if (stored === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Draft revision was not found.',
      );
    const draft = stored.value.artifact.result.draft;
    if (draft.revision !== input.expectedDraftRevision)
      throw new ProductServiceError(
        'STALE_REVISION',
        'Draft revision is stale.',
      );
    await this.#assertCurrentDraftHead(stored.value);
    const recommendation =
      await this.repository.getCurrent<RecommendationArtifact>(
        TENANT_ID,
        'recommendation',
        stored.value.recommendationId,
      );
    if (recommendation === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Recommendation was not found.',
      );
    await this.#assertRecommendationLineage(context, recommendation.value);
    this.#assertDraftLineage(stored.value, recommendation.value);
    const source = this.#sourceForRecommendation(recommendation.value);
    const actionPlan = createDeterministicDurableAgent({
      repository: this.repository,
      retrieval: verifiedEvaluatorRetrieval(this.retrieval, {
        exactEntityRef: source.exactEntityRef,
        topic: source.topic,
      }),
      context,
      now: this.now,
      authorizedTopic: source.topic,
    }).prepareApprovalActionPlan({
      artifact: stored.value.artifact,
      policyVersion: 'effect-disabled-v1',
      expiresAt: EXPIRES_AT,
    });
    await this.#assertCurrentDraftHead(stored.value);
    const actionPlanId = actionPlan.actionPlanId;
    const proposalId = id('proposal', { actionPlanId, revision: 1 });
    const existing = await this.repository.getCurrent<StoredProposal>(
      TENANT_ID,
      'proposal',
      proposalId,
    );
    if (existing !== undefined) {
      if (
        existing.value.draftRevisionId !== draft.draftRevisionId ||
        existing.value.actionPlan.canonicalHash !== actionPlan.canonicalHash
      )
        throw new ProductServiceError(
          'STALE_REVISION',
          'The proposal binding conflicts with durable state.',
        );
      await this.#assertProposalLineage(context, existing.value);
      await this.#registerProposal(existing.value.proposalId);
      await this.#assertProposalLineage(context, existing.value);
      return this.#prepareApprovalResult(existing.value);
    }
    const updatedAt = this.now();
    const proposal: StoredProposal = {
      proposalId,
      draftRevisionId: draft.draftRevisionId,
      actionPlan,
      status: 'pending_approval',
      approvalUrl: productUrl(this.baseUrl, `/approvals/${proposalId}`),
      updatedAt,
    };
    try {
      await this.repository.putRevision(TENANT_ID, {
        entityType: 'proposal',
        entityId: proposalId,
        revisionId: `${proposalId}:pending`,
        version: 1,
        committedAt: updatedAt,
        value: proposal,
      });
    } catch (error) {
      if (!(error instanceof PersistenceConflictError)) throw error;
    }
    const persisted = await this.repository.getCurrent<StoredProposal>(
      TENANT_ID,
      'proposal',
      proposalId,
    );
    if (persisted === undefined) throw new Error('PROPOSAL_HEAD_NOT_PERSISTED');
    await this.#assertProposalLineage(context, persisted.value);
    await this.#registerProposal(persisted.value.proposalId);
    await this.#assertProposalLineage(context, persisted.value);
    return this.#prepareApprovalResult(persisted.value);
  }

  async #registerProposal(proposalId: string): Promise<void> {
    for (
      let attempt = 0;
      attempt < PROPOSAL_INDEX_WRITE_ATTEMPTS;
      attempt += 1
    ) {
      const current = await this.repository.getCurrent<StoredProposalIndex>(
        TENANT_ID,
        'proposal-index',
        PROPOSAL_INDEX_ID,
      );
      const currentProposalIds =
        current === undefined ? [] : readProposalIndex(current.value);
      if (currentProposalIds.includes(proposalId)) return;
      const proposalIds = [...currentProposalIds, proposalId].sort(
        (left, right) => left.localeCompare(right),
      );
      const version = (current?.version ?? 0) + 1;
      try {
        await this.repository.putRevision(TENANT_ID, {
          entityType: 'proposal-index',
          entityId: PROPOSAL_INDEX_ID,
          revisionId: id('proposal-index-revision', { version, proposalIds }),
          version,
          ...(current === undefined
            ? {}
            : {
                expectedVersion: current.version,
                expectedRevisionId: current.revisionId,
              }),
          committedAt: this.now(),
          value: {
            schemaVersion: '1',
            proposalIds,
          } satisfies StoredProposalIndex,
        });
        return;
      } catch (error) {
        if (!(error instanceof PersistenceConflictError)) throw error;
      }
    }
    throw new ProductServiceError(
      'STALE_REVISION',
      'The durable proposal index remained contended.',
    );
  }

  async #pendingApprovalCount(context: ProductRequestContext): Promise<number> {
    const index = await this.repository.getCurrent<StoredProposalIndex>(
      TENANT_ID,
      'proposal-index',
      PROPOSAL_INDEX_ID,
    );
    if (index === undefined) return 0;
    const proposalIds = readProposalIndex(index.value);
    const proposals = await Promise.all(
      proposalIds.map((proposalId) =>
        this.repository.getCurrent<StoredProposal>(
          TENANT_ID,
          'proposal',
          proposalId,
        ),
      ),
    );
    if (
      proposals.some(
        (proposal, index) =>
          proposal === undefined ||
          proposal.value.proposalId !== proposalIds[index] ||
          (proposal.value.status !== 'pending_approval' &&
            proposal.value.status !== 'approved'),
      )
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'The durable proposal index does not match proposal state.',
      );
    let pendingApprovalCount = 0;
    for (const proposal of proposals) {
      if (proposal === undefined)
        throw new ProductServiceError(
          'STALE_REVISION',
          'The durable proposal index does not match proposal state.',
        );
      try {
        await this.#assertProposalLineage(context, proposal.value);
      } catch (error) {
        if (
          error instanceof ProductServiceError &&
          error.code === 'STALE_REVISION'
        )
          continue;
        throw error;
      }
      if (proposal.value.status === 'pending_approval')
        pendingApprovalCount += 1;
    }
    return pendingApprovalCount;
  }

  #prepareApprovalResult(proposal: StoredProposal): PrepareDraftApprovalResult {
    return prepareDraftApprovalResultSchema.parse({
      proposalId: proposal.proposalId,
      approvalUrl: proposal.approvalUrl,
      status: proposal.status,
      directEffectAvailable: false,
      actionPlanId: proposal.actionPlan.actionPlanId,
      actionPlanRevision: proposal.actionPlan.revision,
      actionPlanHash: proposal.actionPlan.canonicalHash,
      updatedAt: proposal.updatedAt,
    });
  }

  public async approveProposal(
    context: ProductRequestContext,
    input: {
      readonly proposalId: string;
      readonly expectedProposalUpdatedAt: string;
    },
  ): Promise<ApproveProposalResult> {
    this.#assertContext(context);
    const current = await this.repository.getCurrent<StoredProposal>(
      TENANT_ID,
      'proposal',
      input.proposalId,
    );
    if (current === undefined)
      throw new ProductServiceError('NOT_FOUND', 'Proposal was not found.');
    const proposal = current.value;
    await this.#assertProposalLineage(context, proposal);
    if (proposal.status === 'approved') {
      if (
        proposal.approvedFromUpdatedAt !== input.expectedProposalUpdatedAt &&
        proposal.updatedAt !== input.expectedProposalUpdatedAt
      )
        throw new ProductServiceError(
          'STALE_REVISION',
          'Proposal revision is stale.',
        );
      const result = this.#approvalResult(proposal);
      await this.operationQueue?.enqueue(result.operationId);
      return result;
    }
    if (proposal.updatedAt !== input.expectedProposalUpdatedAt)
      throw new ProductServiceError(
        'STALE_REVISION',
        'Proposal revision is stale.',
      );
    const operation = proposal.actionPlan.operations[0];
    if (operation === undefined || operation.kind !== 'send_message')
      throw new ProductServiceError(
        'INVALID_INPUT',
        'Proposal operation is invalid.',
      );
    const approvedAt = this.now();
    const connectorSnapshot = connectorSnapshotSchema.parse({
      connectorId: 'gmail',
      descriptorVersion: '1',
      accountId: ACCOUNT_ID,
      capabilitySnapshotHash: sha256('public-gmail-effect-disabled'),
      runtimeMode: 'fixture' as const,
      selectionState: 'selected' as const,
    });
    const binding: OperationApprovalBinding = {
      operationId: operation.operationId,
      attemptId: attemptIdSchema.parse(
        id('attempt', { operationId: operation.operationId }),
      ),
      account: {
        tenantId: TENANT_ID,
        accountId: ACCOUNT_ID,
        expectedStateVersion: 1,
      },
      connectorSnapshot,
      renderedPayloadFingerprint: operation.renderedPayloadFingerprint,
      draftRevisionId: operation.draftRevisionId,
      clientCorrelation: {
        kind: 'client_reference',
        value: operation.operationId,
      },
      correlationBindingVersion: '1',
      reconciliationStrategy: 'effect-disabled-terminal',
      reconciliationStrategyVersion: '1',
      contactPolicies: [
        {
          tenantId: TENANT_ID,
          contactIdentityDigest: operation.recipientDigests[0] as never,
          channel: 'email',
          connectorAccountId: ACCOUNT_ID,
          brandId: BRAND_ID,
          projectionVersion: 1,
        },
      ],
      effectSwitch: {
        globalVersion: 1,
        accountVersion: 1,
        operationVersion: 1,
        policy: 'effect_disabled',
      },
    };
    const bundle = buildImmutableApprovalBundle({
      actor: context.actor,
      actionPlan: proposal.actionPlan,
      approvalId: id('approval', { proposalId: proposal.proposalId }),
      executionIntentId: id('intent', { proposalId: proposal.proposalId }),
      approvedAt,
      bindings: [binding],
    });
    const immutableOperation = bundle.operations[0];
    if (immutableOperation === undefined)
      throw new Error('APPROVAL_OPERATION_NOT_CREATED');
    const state: AuthoritativeExecutionState = {
      actionPlan: bundle.actionPlan,
      approval: bundle.approval,
      operation: immutableOperation,
      currentSourceMessageRevisionId: bundle.actionPlan.sourceMessageRevisionId,
      approverAuthorityActive: true,
      connector: {
        accountId: ACCOUNT_ID,
        stateVersion: 1,
        status: 'active',
        health: 'healthy',
        snapshot: connectorSnapshot,
        operationCapabilityEnabled: true,
      },
      contactPolicies: [
        {
          schemaVersion: '1',
          tenantId: TENANT_ID,
          contactIdentityDigest: operation.recipientDigests[0] as never,
          channel: 'email',
          connectorAccountId: ACCOUNT_ID,
          brandId: BRAND_ID,
          state: 'allowed',
          applicableFactIds: [],
          reducerVersion: '1',
          projectionVersion: 1,
          updatedAt: approvedAt,
        },
      ],
      effectSwitch: {
        ...binding.effectSwitch,
        globalEnabled: false,
        accountEnabled: false,
        operationEnabled: false,
      },
    };
    const receipt = {
      kind: 'effect_disabled' as const,
      operationId: operation.operationId,
      artifactHash: immutableOperation.artifactHash,
      stableIdempotencyKey: immutableOperation.artifact.stableIdempotencyKey,
      observedAt: approvedAt,
    };
    const built = buildDynamoApprovalExecutionRecords({
      state,
      createdAt: approvedAt,
    });
    const execution: DynamoApprovalExecutionRecords = {
      ...built,
      aggregate: {
        ...built.aggregate,
        executionStatus: 'settled',
        executionOutcome: 'effect_disabled',
        attemptCount: 1,
        stateVersion: 2,
        effectDisabledReceipt: receipt,
        settledAt: approvedAt,
      } as unknown as DynamoApprovalExecutionRecords['aggregate'],
    };
    const approved: StoredProposal = {
      ...proposal,
      status: 'approved',
      updatedAt: approvedAt,
      approvalId: bundle.approval.approvalId,
      operationId: operation.operationId,
      receipt,
      approvedFromUpdatedAt: proposal.updatedAt,
    };
    const expectedDraftHead = await this.#assertProposalLineage(
      context,
      proposal,
    );
    try {
      await this.repository.approveAtomically(TENANT_ID, {
        expectedDraftHead,
        proposal: {
          entityType: 'proposal',
          entityId: proposal.proposalId,
          revisionId: `${proposal.proposalId}:approved:${bundle.approval.approvalId}`,
          version: current.version + 1,
          expectedVersion: current.version,
          expectedRevisionId: current.revisionId,
          committedAt: approvedAt,
          value: approved,
        },
        execution,
      });
    } catch (error) {
      if (!(error instanceof PersistenceConflictError)) throw error;
    }
    const reloaded = await this.repository.getCurrent<StoredProposal>(
      TENANT_ID,
      'proposal',
      input.proposalId,
    );
    if (
      reloaded?.value.status !== 'approved' ||
      reloaded.value.approvedFromUpdatedAt !== input.expectedProposalUpdatedAt
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'Approval transaction conflicted.',
      );
    await this.#assertProposalLineage(context, reloaded.value);
    const result = this.#approvalResult(reloaded.value);
    await this.operationQueue?.enqueue(result.operationId);
    return result;
  }

  #approvalResult(proposal: StoredProposal): ApproveProposalResult {
    if (
      proposal.status !== 'approved' ||
      proposal.approvalId === undefined ||
      proposal.operationId === undefined ||
      proposal.receipt === undefined
    )
      throw new Error('MALFORMED_APPROVED_PROPOSAL');
    return approveProposalResultSchema.parse({
      proposalId: proposal.proposalId,
      actionPlanId: proposal.actionPlan.actionPlanId,
      actionPlanRevision: proposal.actionPlan.revision,
      actionPlanHash: proposal.actionPlan.canonicalHash,
      approvalId: proposal.approvalId,
      operationId: proposal.operationId,
      status: 'approved',
      effectPolicy: 'effect_disabled',
      externalEffect: false,
      receipt: proposal.receipt,
      updatedAt: proposal.updatedAt,
    });
  }

  public async getApprovalStatus(
    context: ProductRequestContext,
    input: { readonly proposalId: string },
  ) {
    this.#assertContext(context);
    const current = await this.repository.getCurrent<StoredProposal>(
      TENANT_ID,
      'proposal',
      input.proposalId,
    );
    if (current === undefined)
      throw new ProductServiceError('NOT_FOUND', 'Proposal was not found.');
    await this.#assertProposalLineage(context, current.value);
    return getApprovalStatusResultSchema.parse({
      proposalId: current.value.proposalId,
      status: current.value.status,
      approvalUrl: current.value.approvalUrl,
      updatedAt: current.value.updatedAt,
    });
  }

  public async getExecutionStatus(
    context: ProductRequestContext,
    input: { readonly proposalId: string },
  ): Promise<ExecutionStatusResult> {
    this.#assertContext(context);
    const current = await this.repository.getCurrent<StoredProposal>(
      TENANT_ID,
      'proposal',
      input.proposalId,
    );
    if (current === undefined)
      throw new ProductServiceError('NOT_FOUND', 'Proposal was not found.');
    await this.#assertProposalLineage(context, current.value);
    return executionStatusResultSchema.parse({
      proposalId: input.proposalId,
      runtimeMode: 'fixture',
      storageMode: 'durable',
      effectPolicy: 'effect_disabled',
      externalEffect: false,
      status:
        current.value.status === 'approved'
          ? 'effect_disabled'
          : 'pending_approval',
      ...(current.value.receipt === undefined
        ? {}
        : { receipt: current.value.receipt }),
    });
  }
}

export const durableEvaluatorAuthority = Object.freeze({
  tenantId: TENANT_ID,
  userId: USER_ID,
  accountId: ACCOUNT_ID,
  brandId: BRAND_ID,
  accountIds: ACCOUNT_IDS,
  brandIds: BRAND_IDS,
});
