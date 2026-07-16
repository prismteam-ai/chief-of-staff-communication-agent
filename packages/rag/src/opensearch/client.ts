import { Client } from '@opensearch-project/opensearch';
// `aws-v3` subpath — the SDK-v3-flavored SigV4 signer this package ships (see the package's own
// `exports` map). It signs every request against the deployed domain using the resolved AWS
// credential chain, which is exactly what's needed for RagStack's IAM-scoped access policy
// (`rag-stack.ts`: account-root-principal resource policy + the processor Lambda's execution role
// granted `es:ESHttp*` identity-side in `ingest-stack.ts`'s `grantIndexAccess` call).
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws-v3';

/**
 * Builds an `@opensearch-project/opensearch` client SigV4-signing every request against the
 * deployed domain. This is the ONLY module in `@chief-of-staff/rag` that imports the OpenSearch
 * client package; everything else (chunking, index mapping, the `RetrievalIndex` interface, the
 * in-memory double) lives in the package root export so consumers who only need the pure
 * contracts never pull the OpenSearch client (or this AWS credential chain) transitively — see
 * `index.ts`'s module doc and `package.json`'s `./opensearch` subpath export.
 */
export function createSignedOpenSearchClient(params: { endpoint: string; region: string }): Client {
  const { endpoint, region } = params;

  return new Client({
    ...AwsSigv4Signer({ region, service: 'es' }),
    node: `https://${endpoint}`,
  });
}

/**
 * Unsigned client for the Docker Compose local replay (`docker-compose.rag.yml` runs with
 * `plugins.security.disabled=true` — no auth, no TLS, matching a throwaway local container, not a
 * production posture). Same `Client` class, same `OpenSearchRetrievalIndex` adapter, same
 * `chunksIndexBody()` mapping as the signed path — only the transport auth differs, which is
 * exactly the "same index mapping + query code" the local-first replay is meant to prove.
 */
export function createLocalOpenSearchClient(params: { node: string }): Client {
  return new Client({ node: params.node });
}
