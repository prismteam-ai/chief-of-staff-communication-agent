# Bounded DynamoDB/S3 retrieval

This runbook covers the assessment-only ADR-020 retrieval implementation in
`@chief/rag/bounded-retrieval`. It implements the frozen `RetrievalIndex`
without adding a second authority, a table scan, a model call, or an external
effect.

## Runtime boundary

DynamoDB remains authoritative for the exact scope head, authorization epoch,
grants, synchronous denies, tombstones, and ordered deltas. S3 contains only
immutable content-addressed snapshot/delta objects. The implementation accepts
two read-only injected ports:

- `RetrievalAuthorityReader`: exact head/epoch reads, bounded delta `Query`,
  exact operational key/index lookup, current authorization hydration, and
  retrieval of a previously persisted query vector;
- `SnapshotObjectReader`: immutable object reads by the frozen blob reference.

Neither port exposes `Scan`, `Put`, `Update`, publication, embedding, model, or
network configuration methods. Production adapters may use DynamoDB `GetItem`,
`BatchGetItem`, and `Query`, and S3 `GetObject`; this package does not create AWS
clients or discover credentials. Test adapters are provider-shaped,
credentialless, tenant-separated, and networkless.

`applySnapshot` and `applyDelta` satisfy the frozen `RetrievalIndex` surface by
performing read-only validation. They do not publish or promote a head in this
wave. Snapshot publication remains an upstream workflow: immutable upload,
checksum/count/schema validation, then a conditional authoritative head
promotion.

## Request sequence

1. Validate the server-derived scope authorization epoch.
2. Read the exact DynamoDB snapshot head and require tenant, scope hash, role,
   and epoch equality.
3. Validate the canonical manifest hash and all size/shard/count/profile fields.
4. Read every declared immutable S3 shard into request-local memory.
5. Validate object key content addressing, object version reference, byte
   length, SHA-256, UTF-8 JSONL projection ordering, and binary32 vectors.
6. Query all deltas after the snapshot watermark, following at most four pages.
   Require gap-free sequence numbers and overlay every upsert/delete/tombstone.
7. Hydrate current grants, denies, tombstones, source versions, citation labels,
   and content hashes for all opaque chunk IDs.
8. Recheck the authorization epoch before scoring.
9. Retrieve the precomputed query vector by query/profile hash. No model call or
   embedding fallback exists in this implementation.
10. Resolve current thread/person/Asana references through the exact operational
    key/index lookup and score only authorized active records using that exact
    evidence, real tokenized BM25, and exhaustive binary32 cosine.
11. Apply the immutable `chief-bounded-fusion-v1` weights, deterministic UTF-8
    chunk-ID tie-breaking, thresholding, and abstention.
12. Assemble citations only from current authorization hydration and recheck the
    epoch immediately before returning any ordering, score, citation, or count.

An epoch race retries once with the newly read epoch. A second race denies the
request. Missing hydration is a deny, never a placeholder. An active hydration
is usable only when its authoritative source version and content hash still bind
the projected version and exact UTF-8 text; drift denies that projection rather
than citing stale text under current metadata.

Object-reader failures are normalized at the boundary. Snapshot reads emit only
`CORRUPT_SNAPSHOT`; delta reads emit only `INDEX_REFRESH_REQUIRED`. Underlying
bucket names, object keys, provider messages, and SDK error details never cross
the retrieval error surface.

## Snapshot format

Each shard pairs a manifest-ordered UTF-8 JSONL chunk table with an IEEE-754
binary32 little-endian row-major vector object. Rows are strictly increasing by
UTF-8 chunk-ID bytes and unique across shards. A JSONL row has exactly:

```json
{
  "schemaVersion": "1",
  "chunkId": "chunk-apollo",
  "sourceId": "source-apollo",
  "sourceVersion": "3",
  "text": "Apollo launch budget approval",
  "tokenCount": 4,
  "exactEntityRefs": ["asana-task-12001", "thread-apollo"]
}
```

Vectors are never JSON numeric arrays. The decoder requires exactly
`rowCount * dimension * 4` bytes, rejects non-finite/zero vectors and trailing
bytes, and reads every component explicitly as little-endian float32. Golden
fixtures bind Node float32 score parity.

Manifest hashes use recursively key-sorted canonical JSON with the
`manifestHash` member omitted. Every immutable object key must contain its
lowercase SHA-256 content hash. The frozen contract's object version, byte
length, encryption key reference, retention policy, and media type remain part
of the hash-bound manifest.

## Delta format and reconstruction

A delta object is a JSON array of gap-free records. `upsert` includes the same
strict projection record and a base64 encoding of one binary32 little-endian
vector. `delete` and `tombstone` contain only the opaque chunk ID. JSON vector
arrays are not accepted. Every operation has an exact key set; extra provider
metadata, invalid chunk IDs, noncanonical base64, zero-change manifests, count
mismatches, and start/end/interior sequence gaps fail closed. `applyDelta`
performs the same parsed-content validation as query-time reconstruction before
reporting success.

The implementation fails with `INDEX_REFRESH_REQUIRED` when any delta page is
missing/incomplete, a sequence has a gap, a page token remains after four
pages, total changes exceed 256, total bytes exceed 4 MiB, the oldest observed
delta exceeds 120 seconds, aggregate snapshot-plus-delta serialized bytes exceed
64 MiB, aggregate decoded projection/vector bytes exceed 128 MiB, or the
reconstructed corpus exceeds 10,000 chunks. Decoded delta bytes include UTF-8
projection fields and decoded binary vectors rather than only the JSON/base64
wire size. The caller must compact and promote a complete new immutable
generation; no partial result is returned.

## Scoring profile

`chief-bounded-fusion-v1` is frozen in source and golden-tested:

- tokenizer: Unicode NFKC, locale-stable lowercase, Unicode letter/number
  tokens with internal apostrophes;
- BM25: Robertson IDF, corpus document frequency, average document length,
  `k1 = 1.2`, `b = 0.75`;
- vector: exhaustive cosine over every currently authorized vector with
  float32 accumulation;
- fusion: normalized lexical `0.45`, normalized cosine `0.40`, exact reference
  `0.15`;
- abstention: no candidate or top fused score below `0.25`.

The factual and style roles use different scope heads and can never mix in one
request. Calibration changes require a new named profile and frozen held-out
goldens rather than silently editing weights.

## Fail-closed codes

The public error contains only one stable code. It deliberately excludes
tenant IDs, object keys, candidate IDs, counts, scores, or metadata.

| Code                     | Meaning                                                                     | Operator action                                                         |
| ------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `ACCESS_DENIED`          | Scope/head/hydration authorization failed or a repeated epoch race occurred | Re-derive scope from verified identity; do not reveal candidate details |
| `AUTHORIZATION_CHANGED`  | Internal one-retry signal for a concurrent epoch advance                    | Automatically retried once; must not leave the boundary                 |
| `INDEX_REFRESH_REQUIRED` | Delta age/size/page/sequence or generation reconstruction is unsafe         | Compact and promote a complete new generation                           |
| `INVALID_QUERY_PROFILE`  | Query vector/profile/dimension/scoring binding drifted                      | Recreate the query using the promoted immutable profile                 |
| `CORRUPT_SNAPSHOT`       | Manifest/object/hash/UTF-8/order/vector validation failed                   | Quarantine the generation and rebuild from authoritative records        |
| `RESOURCE_LIMIT`         | RSS reached 60% or a hard bounded-profile resource gate failed              | Stop retrieval and evaluate ADR-020 OpenSearch promotion                |

`health` maps failures to `unavailable` with zero counts. It never reports a
partial or stale projection as degraded success.

## Hard operational gates

- at most 4 shards;
- at most 10,000 reconstructed chunks;
- at most 64 MiB serialized snapshot payload;
- at most 128 MiB decoded request data;
- fail at RSS greater than or equal to 60% of the injected runtime limit;
- at most 4 complete delta pages, 256 changes, 4 MiB, and 120 seconds;
- at most 100 exact entity refs/candidates through the frozen contract.

The approximately 62,000-row LinkedIn archive is not admissible unchanged.
Crossing any hard gate requires bounded preselection or ADR-020 promotion; it
must never cause truncation.

## Read-only inspection

`inspect(scope)` executes the same epoch, manifest, object, delta, hash, count,
memory, current-grant, deny, and tombstone validations as query, then returns
only the authorized scope's generation/epoch/active-count/shard/hash summary.
Applied deltas are reported as zero pending work so their unauthorized change
count cannot leak. Inspection does not hydrate text to a caller, cache user
data, mutate AWS, or publish a head.

## Verification

Use Node `22.18.0` and the existing frozen lockfile:

```powershell
$env:PATH = 'E:\nvm\v22.18.0;' + $env:PATH
node --version
pnpm --filter @chief/rag test
pnpm --filter @chief/rag lint
pnpm --filter @chief/rag typecheck
pnpm --filter @chief/rag build
git diff --check -- packages/rag/src docs/runbooks/bounded-retrieval.md
```

The deterministic suite covers exact/lexical/vector/fusion ablation, Node
binary32 score parity, tenant isolation, revoke filtering, epoch races,
snapshot-plus-delta reconstruction, corruption/profile drift, incomplete
pagination, aggregate serialized/decoded limits, strict delta shapes and
sequences, stale hydration binding, normalized object-read failures, malformed
public inputs, RSS limits, citations, abstention, process reuse, and read-only
inspection. It performs zero network, credential, model, provider, or AWS
mutation calls.
