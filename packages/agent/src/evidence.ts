import { citationSchema, type Citation } from '@chief/contracts/knowledge';
import {
  sha256Schema,
  timestampSchema,
  type TenantId,
  type UserId,
} from '@chief/contracts/ids';
import type { RetrievalQuery } from '@chief/contracts/knowledge';
import type {
  AuthorizedRetrievalResult,
  BoundedDynamoS3RetrievalIndex,
} from '@chief/rag/bounded-retrieval';

import { immutableHash } from './canonical.js';

export type EvidenceSourceKind =
  'communication' | 'organization_knowledge' | 'asana';

export interface EvidenceQuery {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly brandId: string;
  readonly scopeHash: string;
  readonly queryText: string;
  readonly exactEntityRefs: readonly string[];
}

export interface EvidenceFact {
  readonly factId: string;
  readonly tenantId: TenantId;
  readonly sourceKind: EvidenceSourceKind;
  readonly statement: string;
  readonly citation: Citation;
  readonly sourceTimestamp: string;
}

export interface EvidenceSourceResult {
  readonly snapshotManifestHash: string;
  readonly facts: readonly EvidenceFact[];
}

export interface EvidenceSource {
  readonly kind: EvidenceSourceKind;
  retrieve(query: EvidenceQuery): Promise<EvidenceSourceResult>;
}

export interface EvidenceFactHydrator {
  hydrate(input: {
    readonly tenantId: TenantId;
    readonly sourceKind: EvidenceSourceKind;
    readonly retrieval: AuthorizedRetrievalResult;
  }): Promise<readonly EvidenceFact[]>;
}

/**
 * Production bridge to the frozen bounded retrieval implementation. The
 * planner remains the server-authorized owner of RetrievalQuery scope fields;
 * this adapter cannot invent a tenant or authorization epoch.
 */
export class BoundedRetrievalEvidenceSource implements EvidenceSource {
  public constructor(
    public readonly kind: EvidenceSourceKind,
    private readonly index: Pick<
      BoundedDynamoS3RetrievalIndex,
      'queryWithCitations'
    >,
    private readonly plan: (query: EvidenceQuery) => RetrievalQuery,
    private readonly hydrator: EvidenceFactHydrator,
  ) {}

  public async retrieve(query: EvidenceQuery): Promise<EvidenceSourceResult> {
    const planned = this.plan(query);
    if (
      planned.scope.tenantId !== query.tenantId ||
      planned.scope.scopeHash !== query.scopeHash ||
      planned.scope.derivation !== 'server_grants' ||
      planned.scope.role !== 'factual'
    )
      throw new EvidenceBoundaryError('TENANT_SCOPE_MISMATCH');
    const retrieval = await this.index.queryWithCitations(planned);
    const facts = await this.hydrator.hydrate({
      tenantId: query.tenantId,
      sourceKind: this.kind,
      retrieval,
    });
    return Object.freeze({
      snapshotManifestHash: retrieval.snapshotManifestHash,
      facts: Object.freeze([...facts]),
    });
  }
}

export interface CitedContext {
  readonly facts: readonly EvidenceFact[];
  readonly citations: readonly Citation[];
  readonly snapshotManifestHash: string;
  readonly queryHash: string;
}

const sourceOrder: Record<EvidenceSourceKind, number> = {
  communication: 0,
  organization_knowledge: 1,
  asana: 2,
};

export class EvidenceBoundaryError extends Error {
  public constructor(
    public readonly code:
      | 'INCOMPLETE_SOURCE_SET'
      | 'TENANT_SCOPE_MISMATCH'
      | 'DUPLICATE_FACT'
      | 'INVALID_EVIDENCE',
  ) {
    super(code);
    this.name = 'EvidenceBoundaryError';
  }
}

export class CitedContextRetriever {
  readonly #sources: readonly EvidenceSource[];
  readonly #limitPerSource: number;

  public constructor(
    sources: readonly EvidenceSource[],
    options: { readonly limitPerSource?: number } = {},
  ) {
    const kinds = sources.map(({ kind }) => kind);
    const required: readonly EvidenceSourceKind[] = [
      'communication',
      'organization_knowledge',
      'asana',
    ];
    if (
      sources.length !== required.length ||
      required.some(
        (kind) => kinds.filter((candidate) => candidate === kind).length !== 1,
      )
    ) {
      throw new EvidenceBoundaryError('INCOMPLETE_SOURCE_SET');
    }
    this.#sources = Object.freeze(
      [...sources].sort(
        (left, right) => sourceOrder[left.kind] - sourceOrder[right.kind],
      ),
    );
    this.#limitPerSource = Math.min(
      20,
      Math.max(1, options.limitPerSource ?? 8),
    );
  }

  public async retrieve(query: EvidenceQuery): Promise<CitedContext> {
    if (
      !sha256Schema.safeParse(query.scopeHash).success ||
      !query.queryText.trim() ||
      query.queryText.length > 16_000 ||
      query.exactEntityRefs.length > 100
    )
      throw new EvidenceBoundaryError('INVALID_EVIDENCE');
    const queryHash = immutableHash({
      ...query,
      exactEntityRefs: [...query.exactEntityRefs].sort(),
    });
    const results = await Promise.all(
      this.#sources.map(async (source) => ({
        kind: source.kind,
        result: await source.retrieve(query),
      })),
    );
    const factIds = new Set<string>();
    const citationIds = new Set<string>();
    const facts: EvidenceFact[] = [];
    for (const { kind, result } of results) {
      if (!sha256Schema.safeParse(result.snapshotManifestHash).success)
        throw new EvidenceBoundaryError('INVALID_EVIDENCE');
      for (const fact of result.facts.slice(0, this.#limitPerSource)) {
        if (fact.tenantId !== query.tenantId || fact.sourceKind !== kind)
          throw new EvidenceBoundaryError('TENANT_SCOPE_MISMATCH');
        if (
          !fact.factId.trim() ||
          !fact.statement.trim() ||
          fact.statement.length > 16_000
        )
          throw new EvidenceBoundaryError('INVALID_EVIDENCE');
        const parsedCitation = citationSchema.safeParse(fact.citation);
        const parsedTimestamp = timestampSchema.safeParse(fact.sourceTimestamp);
        if (!parsedCitation.success || !parsedTimestamp.success)
          throw new EvidenceBoundaryError('INVALID_EVIDENCE');
        if (
          factIds.has(fact.factId) ||
          citationIds.has(fact.citation.citationId)
        )
          throw new EvidenceBoundaryError('DUPLICATE_FACT');
        factIds.add(fact.factId);
        citationIds.add(fact.citation.citationId);
        facts.push(
          Object.freeze({
            ...fact,
            statement: fact.statement.trim(),
            citation: parsedCitation.data,
            sourceTimestamp: parsedTimestamp.data,
          }),
        );
      }
    }
    facts.sort(
      (left, right) =>
        sourceOrder[left.sourceKind] - sourceOrder[right.sourceKind] ||
        right.sourceTimestamp.localeCompare(left.sourceTimestamp) ||
        left.factId.localeCompare(right.factId),
    );
    const citations = facts.map(({ citation }) => citation);
    return Object.freeze({
      facts: Object.freeze(facts),
      citations: Object.freeze(citations),
      queryHash,
      snapshotManifestHash: immutableHash(
        results.map(({ kind, result }) => ({
          kind,
          snapshotManifestHash: result.snapshotManifestHash,
        })),
      ),
    });
  }
}

export function resolveFacts(
  context: CitedContext,
  factIds: readonly string[],
): readonly EvidenceFact[] {
  const byId = new Map(context.facts.map((fact) => [fact.factId, fact]));
  const unique = [...new Set(factIds)];
  if (unique.length !== factIds.length)
    throw new EvidenceBoundaryError('DUPLICATE_FACT');
  return Object.freeze(
    unique.map((factId) => {
      const fact = byId.get(factId);
      if (!fact) throw new EvidenceBoundaryError('INVALID_EVIDENCE');
      return fact;
    }),
  );
}
