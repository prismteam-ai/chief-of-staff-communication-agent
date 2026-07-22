# ADR 0001: Reproducible Chief foundation

- Status: Accepted
- Date: 2026-07-17

## Context

The assessment needs a hosted, extensible Chief of Staff product, but COS-010
must establish runtime and deployment compatibility without prematurely
claiming connector, knowledge, agent, or effectful behavior.

## Decision

Use one strict TypeScript pnpm/Turborepo workspace on Node 22.18.0 with exact
direct dependency versions and a digest-pinned Linux verification image.
Node-side packages use ESM and NodeNext. The web app uses React/Vite and calls a
shared typed browser API layered over a shared tRPC client. The API exposes only
`system.health` through tRPC's official AWS Lambda adapter. MCP exposes health
and returns `501 MCP_FOUNDATION_ONLY` for every other request. Worker
invocations return a typed `externalEffects: disabled` result and are not
provisioned.

Deploy the static web build from a private S3 bucket through CloudFront Origin
Access Control with SPA fallbacks. A separate API Gateway HTTP API invokes only
the API and MCP Node 22 Lambdas. Both use Powertools, active X-Ray, and explicit
90-day log groups. CDK assertions reject Amplify and future business services.

## Tradeoffs

- S3 and CloudFront keep the foundation small and deterministic; the browser
  API base URL remains deployment configuration instead of coupling static
  assets to an unimplemented authentication layer.
- Workers are buildable and testable but absent from CDK until real triggers,
  retries, and effect policies exist.
- No empty domain packages are created. Later verticals add packages only when
  they contain real contracts and behavior.
- The foundation emits platform observability without inventing business
  metrics before business operations exist.

## Consequences

The first graded vertical can extend stable typed boundaries without replacing
the toolchain or deployment shape. No COS-010 surface can send a message,
mutate a task, load credentials, or claim MCP product functionality.
