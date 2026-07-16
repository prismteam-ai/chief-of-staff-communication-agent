/**
 * `@chief-of-staff/rag/opensearch` — the AWS-dependency-bearing subpath (see the package root
 * `index.ts` module doc). Importing from here pulls the `@opensearch-project/opensearch` client
 * and the AWS credential chain; importing from the package root does not.
 */
export * from './client.js';
export * from './retrieval-index.js';
