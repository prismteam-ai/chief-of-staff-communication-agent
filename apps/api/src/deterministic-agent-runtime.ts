import type {
  DraftArtifact,
  DraftHeadReader,
  RecommendationArtifact,
  RecommendationHeadReader,
} from '@chief/agent/application-agent';
import { ChiefCommunicationAgent } from '@chief/agent/application-agent';
import {
  CitedContextRetriever,
  type EvidenceFact,
  type EvidenceSource,
  type EvidenceSourceKind,
} from '@chief/agent/evidence';
import type { ModelGateway } from '@chief/model-gateway';

import type { DurableProductRepository } from './durable-product-repository.js';
import type {
  DeterministicEvidenceTopic,
  VerifiedDurableRetrievalPort,
} from './durable-product-service.js';
import type { ProductRequestContext } from './product-service.js';

function promptFactIds(
  value: string,
  authorizedTopic: DeterministicEvidenceTopic | undefined,
): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return [];
  const prompt = parsed as {
    readonly task?: unknown;
    readonly untrustedInbound?: {
      readonly subject?: unknown;
      readonly authoredText?: unknown;
    };
    readonly authorizedFacts?: readonly {
      readonly factId?: unknown;
      readonly statement?: unknown;
    }[];
    readonly recommendation?: {
      readonly citedFactIds?: readonly unknown[];
    };
  };
  const queryText = [
    prompt.untrustedInbound?.subject,
    prompt.untrustedInbound?.authoredText,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
  const authorized =
    prompt.task === 'select_next_action' &&
    queryText.trim() &&
    authorizedTopic !== undefined
      ? (prompt.authorizedFacts ?? [])
          .filter(
            (
              fact,
            ): fact is {
              readonly factId: string;
              readonly statement: string;
            } =>
              typeof fact.factId === 'string' &&
              typeof fact.statement === 'string',
          )
          .map(({ factId }) => factId)
      : [];
  const cited =
    prompt.recommendation?.citedFactIds?.filter(
      (factId): factId is string => typeof factId === 'string',
    ) ?? [];
  return [...authorized, ...cited].filter(
    (factId) =>
      factId.startsWith('fact-') &&
      factId.length <= 165 &&
      factId.trim() === factId,
  );
}

export function deterministicPromptFactIds(
  input: unknown,
  authorizedTopic?: DeterministicEvidenceTopic,
): readonly string[] {
  const factIds = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const factId of promptFactIds(value, authorizedTopic))
        factIds.add(factId);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(input);
  return [...factIds];
}

function createGateway(
  authorizedTopic: DeterministicEvidenceTopic,
): ModelGateway {
  const languageModel = {
    specificationVersion: 'v3',
    provider: 'chief-deterministic-effect-disabled',
    modelId: 'chief-deterministic-effect-disabled-v1',
    supportedUrls: {},
    doGenerate: (options: unknown) => {
      const serialized = JSON.stringify(options);
      const selectedFactIds = deterministicPromptFactIds(
        options,
        authorizedTopic,
      );
      const output = serialized.includes('select_next_action')
        ? {
            actionType:
              selectedFactIds.length > 0 ? 'reply' : 'request_context',
            urgency: 'high',
            selectedFactIds,
            missingFacts: selectedFactIds.length > 0 ? [] : ['cited context'],
          }
        : {
            responseMode:
              selectedFactIds.length > 0 ? 'answer' : 'request_context',
            selectedFactIds,
            includeGreeting: true,
            includeSignoff: true,
          };
      return Promise.resolve({
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      });
    },
  } as unknown as ModelGateway['languageModel'];
  return {
    profile: {
      schemaVersion: '1',
      profileId: 'chief-deterministic-effect-disabled-v1',
      modelId: 'chief-deterministic-effect-disabled-v1',
      region: 'us-east-2',
      gateway: 'vercel-ai-sdk',
      gatewayVersion: 'ai@6',
      promptPolicyHash:
        '8c649ad127e441ca64a675bb806cbdfa90357d0aa68791c0d6a41a13880c3dc6',
      actionContextRoute: 'chief-action-v1',
      draftRoute: 'chief-draft-v1',
      manifestHash:
        '4cf8f907e056ac99df48f091653e10900adc358e23628b0b27852322e75c6410',
    },
    languageModel,
    fallbackProfile: null,
    promptCacheMetadata: {
      bedrock_prompt_caching: true,
      bedrock_prompt_cache_strategy: 'system_and_last_non_system',
      bedrock_prompt_cache_ttl: 'default',
      bedrock_prompt_cache_tool_config: false,
    },
  };
}

class RetrievalEvidenceSource implements EvidenceSource {
  public constructor(
    public readonly kind: EvidenceSourceKind,
    private readonly retrieval: VerifiedDurableRetrievalPort,
    private readonly context: ProductRequestContext,
    private readonly authorizedTopic: DeterministicEvidenceTopic,
  ) {}

  public async retrieve(query: {
    readonly tenantId: string;
    readonly scopeHash: string;
    readonly queryText: string;
    readonly exactEntityRefs: readonly string[];
  }) {
    const result = await this.retrieval.search(this.context, {
      queryText: query.queryText,
      exactEntityRefs: query.exactEntityRefs,
      limit: 8,
    });
    const evidenceByCitation = new Map(
      result.evidence.map((item) => [item.citationId, item]),
    );
    const candidateByChunk = new Map(
      result.candidates.map((candidate) => [candidate.chunkId, candidate]),
    );
    const facts: EvidenceFact[] = [];
    for (const citation of result.citations) {
      const evidence = evidenceByCitation.get(citation.citationId);
      const candidate = candidateByChunk.get(citation.chunkId);
      if (
        evidence === undefined ||
        candidate === undefined ||
        evidence.chunkId !== citation.chunkId ||
        evidence.sourceClass !== this.kind ||
        evidence.relation.verified !== true
      )
        continue;
      if (
        !query.exactEntityRefs.some((reference) =>
          evidence.relation.exactEntityRefs.includes(reference),
        ) ||
        evidence.relation.topic !== this.authorizedTopic
      )
        continue;
      facts.push({
        factId: `fact-${citation.chunkId}`,
        tenantId: query.tenantId as EvidenceFact['tenantId'],
        sourceKind: this.kind,
        statement: evidence.text,
        citation,
        sourceTimestamp: '2026-07-17T12:00:00.000Z',
        relevanceScore: candidate.fusedScore,
      });
    }
    return {
      snapshotManifestHash: result.snapshotManifestHash,
      facts,
    };
  }
}

export function createDeterministicDurableAgent(input: {
  readonly repository: DurableProductRepository;
  readonly retrieval: VerifiedDurableRetrievalPort;
  readonly context: ProductRequestContext;
  readonly now: () => string;
  readonly authorizedTopic: DeterministicEvidenceTopic;
}): ChiefCommunicationAgent {
  let monotonicTick = 0;
  const recommendationHeads: RecommendationHeadReader = {
    isCurrent: async ({ tenantId, recommendationId, revision }) => {
      const current = await input.repository.getCurrent<RecommendationArtifact>(
        tenantId,
        'recommendation',
        recommendationId,
      );
      return current?.value.recommendation.revision === revision;
    },
  };
  const draftHeads: DraftHeadReader = {
    getCurrentRevision: async ({ tenantId, draftId }) => {
      const current = await input.repository.getCurrent<{
        readonly artifact: DraftArtifact;
      }>(tenantId, 'draft', draftId);
      return current === undefined
        ? null
        : {
            draftRevisionId:
              current.value.artifact.result.draft.draftRevisionId,
            revision: current.value.artifact.result.draft.revision,
          };
    },
  };
  const retriever = new CitedContextRetriever([
    new RetrievalEvidenceSource(
      'communication',
      input.retrieval,
      input.context,
      input.authorizedTopic,
    ),
    new RetrievalEvidenceSource(
      'organization_knowledge',
      input.retrieval,
      input.context,
      input.authorizedTopic,
    ),
    new RetrievalEvidenceSource(
      'asana',
      input.retrieval,
      input.context,
      input.authorizedTopic,
    ),
  ]);
  return new ChiefCommunicationAgent({
    gateway: createGateway(input.authorizedTopic),
    retriever,
    recommendationHeads,
    draftHeads,
    clock: {
      now: () => new Date(input.now()),
      monotonicMilliseconds: () => {
        monotonicTick += 1;
        return monotonicTick;
      },
    },
  });
}
