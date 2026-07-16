/**
 * `@chief-of-staff/agent-handler/style` — the Task 10 style-learning subpath, exported so
 * `scripts/build-style-profile.ts` (the `just build-style-profile` CLI, brief constraint 4) can
 * drive the SAME orchestration/extraction code the agent Lambda's `getStyleProfile` seam reads
 * from, rather than a parallel reimplementation. Mirrors `@chief-of-staff/rag`'s `./opensearch`
 * subpath-export precedent — one package, a narrow public surface for one external consumer.
 */
export * from './build-style-profile.js';
export * from './style-card.js';
export * from './style-profile-repo.js';
