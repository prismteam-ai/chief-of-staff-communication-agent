import {
  actionPlanSchema,
  actionRecommendationSchema,
  approvalSchema,
  attachmentSchema,
  connectorAccountSchema,
  contactChannelPolicySchema,
  draftRevisionSchema,
  knowledgeChunkSchema,
  knowledgeSourceSchema,
  membershipSchema,
  messageRevisionSchema,
  messageSchema,
  providerThreadSchema,
  suppressionFactSchema,
  tenantSchema,
  topicLinkSchema,
  topicSchema,
  userSchema,
  workObjectFactSchema,
  type MessageRevision,
} from '@chief/contracts';

import { computeDemoCorpusHash } from './corpus.js';
import { stableHash } from './deterministic.js';
import {
  demoChannels,
  type DemoChannel,
  type DemoCorpus,
  type DemoCorpusCounts,
  type DemoValidationReport,
} from './types.js';

function counts(corpus: DemoCorpus): DemoCorpusCounts {
  return {
    tenants: corpus.tenants.length,
    brands: corpus.brands.length,
    accounts: corpus.accounts.length,
    threads: corpus.threads.length,
    messages: corpus.messages.length,
    attachments: corpus.attachments.length,
    asanaObjects: corpus.asanaObjects.length,
    styleExamples: corpus.styleExamples.length,
    edgeCases: corpus.edgeCases.length,
    knowledgeSources: corpus.knowledgeSources.length,
    knowledgeChunks: corpus.knowledgeChunks.length,
  };
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function channelCoverage(corpus: DemoCorpus): readonly DemoChannel[] {
  const present = new Set(corpus.threads.map((thread) => thread.channel));
  return demoChannels.filter((channel) => present.has(channel));
}

function validateSchemas(corpus: DemoCorpus, errors: string[]): void {
  const checks: readonly [
    string,
    readonly unknown[],
    { safeParse(value: unknown): { success: boolean } },
  ][] = [
    ['tenant', corpus.tenants, tenantSchema],
    ['user', corpus.users, userSchema],
    ['membership', corpus.memberships, membershipSchema],
    ['account', corpus.accounts, connectorAccountSchema],
    ['thread', corpus.threads, providerThreadSchema],
    ['message', corpus.messages, messageSchema],
    ['message revision', corpus.messageRevisions, messageRevisionSchema],
    ['attachment', corpus.attachments, attachmentSchema],
    ['topic', corpus.topics, topicSchema],
    ['topic link', corpus.topicLinks, topicLinkSchema],
    ['suppression fact', corpus.suppressionFacts, suppressionFactSchema],
    ['contact policy', corpus.contactPolicies, contactChannelPolicySchema],
    ['knowledge source', corpus.knowledgeSources, knowledgeSourceSchema],
    ['knowledge chunk', corpus.knowledgeChunks, knowledgeChunkSchema],
    [
      'Asana object',
      corpus.asanaObjects.map((item) => item.object),
      workObjectFactSchema,
    ],
    [
      'scenario recommendation',
      [corpus.scenario.recommendation],
      actionRecommendationSchema,
    ],
    ['scenario draft', [corpus.scenario.draft], draftRevisionSchema],
    ['scenario action plan', [corpus.scenario.actionPlan], actionPlanSchema],
    ['scenario approval', corpus.scenario.approvals, approvalSchema],
  ];
  for (const [label, values, schema] of checks) {
    values.forEach((value, index) => {
      if (!schema.safeParse(value).success)
        errors.push(`${label}[${index}] violates its frozen contract`);
    });
  }
}

function validateReferentialIntegrity(
  corpus: DemoCorpus,
  errors: string[],
): void {
  const tenantIds = new Set<string>(
    corpus.tenants.map((tenant) => tenant.tenantId),
  );
  const accountById = new Map<string, DemoCorpus['accounts'][number]>(
    corpus.accounts.map((account) => [account.accountId, account]),
  );
  const threadById = new Map<string, DemoCorpus['threads'][number]>(
    corpus.threads.map((thread) => [thread.threadId, thread]),
  );
  const revisionById = new Map<string, DemoCorpus['messageRevisions'][number]>(
    corpus.messageRevisions.map((revision) => [revision.revisionId, revision]),
  );
  const messageById = new Map<string, DemoCorpus['messages'][number]>(
    corpus.messages.map((message) => [message.messageId, message]),
  );
  const attachmentById = new Map<string, DemoCorpus['attachments'][number]>(
    corpus.attachments.map((attachment) => [
      attachment.attachmentId,
      attachment,
    ]),
  );
  const sourceById = new Map<string, DemoCorpus['knowledgeSources'][number]>(
    corpus.knowledgeSources.map((source) => [source.sourceId, source]),
  );
  const topicById = new Map<string, DemoCorpus['topics'][number]>(
    corpus.topics.map((topic) => [topic.topicId, topic]),
  );
  const bodyByRef = new Map(
    corpus.bodies.map((body) => [body.sourceRef, body]),
  );

  const identitySets: readonly [string, readonly string[]][] = [
    ['account', corpus.accounts.map((item) => item.accountId)],
    ['thread', corpus.threads.map((item) => item.threadId)],
    ['message', corpus.messages.map((item) => item.messageId)],
    [
      'message revision',
      corpus.messageRevisions.map((item) => item.revisionId),
    ],
    ['attachment', corpus.attachments.map((item) => item.attachmentId)],
    ['topic', corpus.topics.map((item) => item.topicId)],
    ['topic link', corpus.topicLinks.map((item) => item.topicLinkId)],
    ['knowledge source', corpus.knowledgeSources.map((item) => item.sourceId)],
    ['knowledge chunk', corpus.knowledgeChunks.map((item) => item.chunkId)],
    ['edge case', corpus.edgeCases.map((item) => item.caseId)],
  ];
  for (const [label, values] of identitySets) {
    if (!unique(values)) errors.push(`${label} identifiers are not unique`);
  }

  for (const brand of corpus.brands) {
    if (!tenantIds.has(brand.tenantId))
      errors.push(`brand ${brand.brandId} references a missing tenant`);
    for (const accountId of brand.accountIds) {
      const account = accountById.get(accountId);
      if (
        account?.tenantId !== brand.tenantId ||
        account.brandId !== brand.brandId
      ) {
        errors.push(
          `brand ${brand.brandId} has a cross-scope account reference`,
        );
      }
    }
  }
  for (const membership of corpus.memberships) {
    if (!tenantIds.has(membership.tenantId)) {
      errors.push(
        `membership ${membership.userId} references a missing tenant`,
      );
    }
    for (const accountId of membership.accountScopes) {
      if (accountById.get(accountId)?.tenantId !== membership.tenantId) {
        errors.push(
          `membership ${membership.userId} has a cross-tenant account scope`,
        );
      }
    }
  }
  for (const body of corpus.bodies) {
    if (stableHash(body.bodyText) !== body.contentHash) {
      errors.push(`body ${body.sourceRef} content hash is invalid`);
    }
  }
  for (const thread of corpus.threads) {
    const account = accountById.get(thread.connectorSnapshot.accountId);
    const latest = revisionById.get(thread.latestMessageRevisionId);
    if (account?.tenantId !== thread.tenantId)
      errors.push(`thread ${thread.threadId} account scope mismatch`);
    if (
      latest?.tenantId !== thread.tenantId ||
      latest.threadId !== thread.threadId
    ) {
      errors.push(
        `thread ${thread.threadId} latest revision is missing or cross-scoped`,
      );
    }
  }
  for (const message of corpus.messages) {
    const revision = revisionById.get(message.currentRevisionId);
    if (
      revision?.tenantId !== message.tenantId ||
      revision.messageId !== message.messageId ||
      revision.threadId !== message.threadId ||
      !threadById.has(message.threadId)
    ) {
      errors.push(
        `message ${message.messageId} current revision is inconsistent`,
      );
    }
  }
  for (const revision of corpus.messageRevisions) {
    const message = messageById.get(revision.messageId);
    const account = accountById.get(revision.connectorSnapshot.accountId);
    if (
      message?.tenantId !== revision.tenantId ||
      account?.tenantId !== revision.tenantId
    ) {
      errors.push(`revision ${revision.revisionId} crosses a tenant boundary`);
    }
    const fullBody = bodyByRef.get(revision.fullNormalizedBody.objectKey);
    const providerBody = bodyByRef.get(
      revision.immutableProviderBody.objectKey,
    );
    if (
      fullBody?.tenantId !== revision.tenantId ||
      fullBody.contentHash !== revision.fullNormalizedBody.contentHash ||
      providerBody?.tenantId !== revision.tenantId ||
      providerBody.contentHash !== revision.immutableProviderBody.contentHash
    ) {
      errors.push(
        `revision ${revision.revisionId} has an unresolved body reference`,
      );
    }
    for (const attachmentId of revision.attachmentIds) {
      const attachment = attachmentById.get(attachmentId);
      if (
        attachment?.tenantId !== revision.tenantId ||
        attachment.sourceMessageRevisionId !== revision.revisionId
      ) {
        errors.push(
          `revision ${revision.revisionId} has an invalid attachment reference`,
        );
      }
    }
  }
  for (const attachment of corpus.attachments) {
    const body = bodyByRef.get(attachment.blob.objectKey);
    if (
      body?.tenantId !== attachment.tenantId ||
      body.contentHash !== attachment.contentHash
    ) {
      errors.push(
        `attachment ${attachment.attachmentId} has an unresolved body reference`,
      );
    }
  }
  for (const link of corpus.topicLinks) {
    const thread = threadById.get(link.communicationRef);
    const topic = topicById.get(link.linkedEntityId);
    if (
      thread?.tenantId !== link.tenantId ||
      topic?.tenantId !== link.tenantId
    ) {
      errors.push(`topic link ${link.topicLinkId} crosses a tenant boundary`);
    }
  }
  for (const chunk of corpus.knowledgeChunks) {
    const source = sourceById.get(chunk.sourceId);
    const body = bodyByRef.get(chunk.textBody.objectKey);
    if (
      source?.tenantId !== chunk.tenantId ||
      source.role !== chunk.role ||
      source.scopeHash !== chunk.scopeHash ||
      body?.tenantId !== chunk.tenantId ||
      body.contentHash !== chunk.contentHash
    ) {
      errors.push(
        `knowledge chunk ${chunk.chunkId} has an invalid source boundary`,
      );
    }
  }
  for (const source of corpus.knowledgeSources) {
    const body = bodyByRef.get(source.body.objectKey);
    if (
      body?.tenantId !== source.tenantId ||
      body.contentHash !== source.contentHash
    ) {
      errors.push(
        `knowledge source ${source.sourceId} has an unresolved body reference`,
      );
    }
  }
  for (const style of corpus.styleExamples) {
    const source = sourceById.get(style.sourceId);
    const revision = revisionById.get(style.messageRevisionId);
    if (
      source?.tenantId !== style.tenantId ||
      source.role !== 'style' ||
      revision?.tenantId !== style.tenantId ||
      revision.direction !== 'outbound'
    ) {
      errors.push(
        `style example ${style.sourceId} is not an approved tenant-local outbound example`,
      );
    }
  }
  for (const state of corpus.communicationStates) {
    if (
      revisionById.get(state.messageRevisionId)?.tenantId !== state.tenantId
    ) {
      errors.push(
        `communication state ${state.messageRevisionId} crosses a tenant boundary`,
      );
    }
  }
  for (const edgeCase of corpus.edgeCases) {
    if (
      revisionById.get(edgeCase.messageRevisionId)?.tenantId !==
      edgeCase.tenantId
    ) {
      errors.push(`edge case ${edgeCase.caseId} has an invalid revision`);
    }
  }
  for (const policy of corpus.contactPolicies) {
    const winningFact = corpus.suppressionFacts.find(
      (fact) => fact.factId === policy.winningFactId,
    );
    if (
      winningFact?.tenantId !== policy.tenantId ||
      winningFact.connectorAccountId !== policy.connectorAccountId ||
      winningFact.contactIdentityDigest !== policy.contactIdentityDigest
    ) {
      errors.push(
        `contact policy ${policy.winningFactId ?? 'unknown'} has an invalid winning fact`,
      );
    }
  }
  for (const person of corpus.people) {
    if (person.ambiguousWithPersonId !== undefined) {
      const candidate = corpus.people.find(
        (item) => item.personId === person.ambiguousWithPersonId,
      );
      if (candidate?.tenantId !== person.tenantId) {
        errors.push(
          `person ${person.personId} has a cross-tenant ambiguity candidate`,
        );
      }
    }
  }
}

function validateCoverage(corpus: DemoCorpus, errors: string[]): void {
  const actual = counts(corpus);
  const required: readonly [keyof DemoCorpusCounts, number][] = [
    ['tenants', 2],
    ['brands', 2],
    ['accounts', 2],
    ['threads', 150],
    ['messages', 1_000],
    ['attachments', 30],
    ['asanaObjects', 50],
    ['styleExamples', 50],
    ['edgeCases', 100],
  ];
  for (const [field, minimum] of required) {
    if (actual[field] < minimum)
      errors.push(
        `${field} requires at least ${minimum}; found ${actual[field]}`,
      );
  }
  const coverage = channelCoverage(corpus);
  for (const channel of demoChannels) {
    if (!coverage.includes(channel))
      errors.push(`missing channel coverage: ${channel}`);
  }
  if (
    JSON.stringify(coverage) !== JSON.stringify(corpus.manifest.channelCoverage)
  ) {
    errors.push('manifest channel coverage does not match generated threads');
  }
  for (const status of ['answered', 'pending', 'overdue'] as const) {
    if (
      !corpus.communicationStates.some(
        (state) => state.responseStatus === status,
      )
    ) {
      errors.push(`missing communication status coverage: ${status}`);
    }
  }
  for (const category of [
    'prompt_injection',
    'ambiguous_identity',
    'suppression',
    'consent_window',
    'out_of_order',
    'duplicate',
    'attachment_limit',
    'deletion',
    'cross_tenant',
  ] as const) {
    if (!corpus.edgeCases.some((edgeCase) => edgeCase.category === category)) {
      errors.push(`missing edge-case coverage: ${category}`);
    }
  }
  if (
    !corpus.people.some((person) => person.ambiguousWithPersonId !== undefined)
  ) {
    errors.push('ambiguous identity candidates are missing');
  }
  if (!corpus.contactPolicies.some((policy) => policy.state === 'suppressed')) {
    errors.push('suppression policy coverage is missing');
  }
  if (
    !corpus.contactPolicies.some((policy) => policy.state === 'window_closed')
  ) {
    errors.push('consent-window coverage is missing');
  }
}

function validateScenario(corpus: DemoCorpus, errors: string[]): void {
  const scenario = corpus.scenario;
  const revision = corpus.messageRevisions.find(
    (item) => item.revisionId === scenario.primaryMessageRevisionId,
  );
  if (revision?.tenantId !== scenario.tenantId)
    errors.push('scenario primary message is missing or cross-scoped');
  if (
    scenario.recommendation.sourceMessageRevisionId !==
    scenario.primaryMessageRevisionId
  ) {
    errors.push(
      'scenario recommendation is not bound to the primary message revision',
    );
  }
  if (
    scenario.draft.sourceMessageRevisionId !==
      scenario.primaryMessageRevisionId ||
    scenario.actionPlan.sourceMessageRevisionId !==
      scenario.primaryMessageRevisionId
  ) {
    errors.push(
      'scenario draft/action plan is not bound to the primary message revision',
    );
  }
  const activeApproval = scenario.approvals.find(
    (approval) => approval.status === 'active',
  );
  const invalidatedApproval = scenario.approvals.find(
    (approval) => approval.status === 'invalidated',
  );
  if (
    activeApproval?.actionPlanHash !== scenario.actionPlan.canonicalHash ||
    activeApproval.actionPlanId !== scenario.actionPlan.actionPlanId
  ) {
    errors.push(
      'active scenario approval does not bind the exact action-plan hash',
    );
  }
  if (invalidatedApproval === undefined)
    errors.push('scenario lacks stale-revision approval invalidation proof');
  const operation = scenario.actionPlan.operations.find(
    (item) => item.operationId === scenario.expectedAsanaHandoff.operationId,
  );
  if (
    operation?.kind !== 'update_task' ||
    operation.targetRef !== scenario.expectedAsanaHandoff.taskRef ||
    scenario.expectedAsanaHandoff.expectedStatus !== 'approved_effect_disabled'
  ) {
    errors.push(
      'scenario Asana handoff does not match the immutable action plan',
    );
  }
  const sourceIds = new Set(
    corpus.knowledgeSources.map((source) => source.sourceId),
  );
  for (const citation of scenario.recommendation.citations) {
    if (!sourceIds.has(citation.sourceId))
      errors.push(`scenario citation ${citation.citationId} is unresolved`);
  }
  if (
    scenario.expectedSla.trustedIngressToActionableP95Ms >
    scenario.expectedSla.targetMs
  ) {
    errors.push(
      'scenario trusted-ingress actionable p95 exceeds the frozen target',
    );
  }
  if (
    scenario.capabilityLabels.some(
      (label) => label.send || label.externalEffect,
    )
  ) {
    errors.push(
      'fixture scenario capability labels must deny external effects',
    );
  }
}

function validateSyntheticSafety(corpus: DemoCorpus, errors: string[]): void {
  const serialized = JSON.stringify(corpus);
  const secretPatterns: readonly [string, RegExp][] = [
    ['AWS access key', /AKIA[0-9A-Z]{16}/u],
    ['bearer token', /Bearer\s+[A-Za-z0-9._~-]{20,}/iu],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
    ['GitHub token', /gh[oprsu]_[A-Za-z0-9]{20,}/u],
  ];
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(serialized))
      errors.push(`possible ${label} found in synthetic corpus`);
  }
  const emailMatches =
    serialized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? [];
  if (emailMatches.some((email) => !email.toLowerCase().endsWith('.test'))) {
    errors.push('non-reserved email address found in synthetic corpus');
  }
  const unsafeNames = corpus.people.filter(
    (person) => !person.displayName.toLowerCase().includes('synthetic'),
  );
  if (unsafeNames.length > 0)
    errors.push('person labels must state that they are synthetic');
  if (!corpus.manifest.syntheticOnly)
    errors.push('manifest must label the corpus synthetic-only');
}

export function validateDemoCorpus(corpus: DemoCorpus): DemoValidationReport {
  const errors: string[] = [];
  validateSchemas(corpus, errors);
  validateReferentialIntegrity(corpus, errors);
  validateCoverage(corpus, errors);
  validateScenario(corpus, errors);
  validateSyntheticSafety(corpus, errors);
  const actualCounts = counts(corpus);
  if (JSON.stringify(actualCounts) !== JSON.stringify(corpus.manifest.counts)) {
    errors.push('manifest counts do not match generated records');
  }
  const computedHash = computeDemoCorpusHash(corpus);
  if (computedHash !== corpus.manifest.corpusHash)
    errors.push('corpus hash does not match generated content');
  return {
    valid: errors.length === 0,
    errors,
    counts: actualCounts,
    channelCoverage: channelCoverage(corpus),
    computedHash,
  };
}

export function assertValidDemoCorpus(corpus: DemoCorpus): DemoCorpus {
  const report = validateDemoCorpus(corpus);
  if (!report.valid) {
    throw new Error(`Invalid demo corpus:\n${report.errors.join('\n')}`);
  }
  return corpus;
}

export function assertTenantLocalRevision(
  revision: MessageRevision,
  expectedTenantId: string,
): MessageRevision {
  if (revision.tenantId !== expectedTenantId) {
    throw new Error('message revision crossed the expected tenant boundary');
  }
  return revision;
}
