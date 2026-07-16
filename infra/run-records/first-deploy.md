# Run record — Task 1: Monorepo skeleton + CI + first deploy

**Date:** 2026-07-16
**Account:** `033014980397` (sandbox, profile `sandbox`)
**Region:** `us-east-2`
**CDK bootstrap qualifier:** `hnb659fds` (discovered per `integrate-ci-cd` step 2 — exactly one
`/cdk-bootstrap/*/version` SSM parameter existed in the account; `cdk bootstrap` re-run confirmed
idempotent, "no changes")

## Deployed URLs

| Surface | URL | Verified |
| --- | --- | --- |
| API health route | `https://klxrwe0sa3.execute-api.us-east-2.amazonaws.com/health.check` | `curl` → `{"result":{"data":{"ok":true,"ts":"2026-07-16T10:42:59.766Z"}}}` |
| Amplify dashboard | `https://main.dismzb3pzaz79.amplifyapp.com` | `curl` → HTTP 200, hello dashboard HTML |

Both confirmed publicly reachable (no auth) from outside the AWS account, and via `just smoke`
(`scripts/smoke.ts`), which reads both URLs from the live CloudFormation stack outputs so it never
depends on hardcoded infrastructure.

## Stacks deployed (`cdk deploy --all`)

All five stacks from `bin/app.ts`, in dependency order chosen by CDK:

1. `RagStack` — empty-but-deployable placeholder (tagged only). Task 4 fills in OpenSearch.
2. `AgentStack` — empty-but-deployable placeholder (tagged only). Task 5 fills in the agent Lambda.
3. `IngestStack` — empty-but-deployable placeholder (tagged only). Task 3 fills in the ingest pipeline.
4. `AmplifyStack` — repo-less `CfnApp` + `CfnBranch` (`main`) + SPA routing rule.
5. `ApiStack` — tRPC `health` route on one Lambda (Node 22, esbuild bundling via `NodejsFunction`)
   behind API Gateway HTTP API v2; the CloudWatch metrics dashboard; the GitHub OIDC deploy role.

Every stack carries the `project_name: chief-of-staff-agent` tag, applied both as a CloudFormation
stack tag and as a CDK `Tags` Aspect (`lib/constructs/tagged-stack.ts`) so it propagates onto every
taggable resource inside the stack — verified directly on the `TrpcHandler` Lambda and the Amplify
`WebApp` in the synthesized templates.

## Documented adaptations

1. **No custom domain.** This account owns no custom domain (the kit's `build-frontend-backends`
   domain-mapping table only covers the org's own two accounts). `ApiStack` uses the default
   `execute-api` URL. `HttpApi.apiEndpoint` is exposed as the `ApiUrl` CfnOutput and is what the
   smoke test and any future frontend wiring should read.
2. **Repo-less Amplify app.** A GitHub OAuth connection (`CfnApp.repository` + `oauthToken`) needs
   interactive user consent that is not available in this environment. `AmplifyStack` creates a
   `CfnApp` with no `repository` and one `CfnBranch` (`main`, `enableAutoBuild: false`), plus the
   `</^[^.]+$/>` → `/index.html` (200) SPA routing custom rule. Deployment is manual:
   `just deploy` → `just deploy-web` → `scripts/deploy-web.ts` builds `apps/web`, zips `dist/`,
   calls `create-deployment`, PUTs the zip to the returned upload URL, calls `start-deployment`,
   and polls `GetJob` until `SUCCEED`. Verified end to end in this run (job id `1`, status
   `SUCCEED`).
3. **CI trigger branch.** `ci-cd-prod.yml` triggers on push to `feat/pidgeot-agent`, not `main` —
   this fork's `main` mirrors the upstream assignment repo, so the feature branch is the deployable
   line for this assignment (per `docs/plan.md` Task 1 and `docs/design.md` §12).
4. **CI workflows are plain, not the shared org reusable workflows.** The kit's
   `integrate-ci-cd` skill calls out to `Spring-Oaks-Capital-LLC/github-workflows`, an org-internal
   repo not accessible from this fork. `.github/workflows/ci-cd-dev.yml` / `ci-cd-prod.yml` run the
   same `justfile` recipes directly with `aws-actions/configure-aws-credentials` (OIDC) instead of
   calling the shared workflow — documented in `docs/design.md` §12 as an accepted adaptation.
5. **OIDC construct lives inside `ApiStack`, not a sixth stack.** The task brief fixes the stack
   count at five (Ingest/Rag/Agent/Api/Amplify). `lib/constructs/github-oidc-deploy-role.ts` is a
   small shared construct (GitHub OIDC provider + deploy role trusted for
   `repo:jzubielik/chief-of-staff-communication-agent:*`) instantiated inside `ApiStack`, with its
   role ARN published as the `DeployRoleArn` output.
6. **CI verified locally, not in Actions.** No push has happened yet in this task, so the Actions
   runs themselves are unverified — every `just` recipe (`format`, `lint`, `type-check`, `test`,
   `build`, `deploy`) was run locally end to end instead, including a full `cdk deploy --all` +
   `deploy-web` + `smoke` pass (this run). `AWS_DEPLOY_ROLE_ARN` (see below) still needs to be set as
   a repository variable before the workflows can authenticate.

## One-time manual step remaining

Set the GitHub repository variable `AWS_DEPLOY_ROLE_ARN` to:

```
arn:aws:iam::033014980397:role/chief-of-staff-agent-github-actions-deploy
```

This is the `ApiStack.DeployRoleArn` output. CDK cannot set repository variables itself; this is a
one-time `gh variable set` (or Settings → Secrets and variables → Actions → Variables) step outside
the CDK app.

## Metrics registry + dashboard

`cloudwatch-metrics.json` (repo root) registers `RequestProcessed`, `RequestFailed`, and
`ProcessingDuration` for the `api` service, namespace `ChiefOfStaffApi`. `ApiStack` renders all
three on a CloudWatch dashboard (`chief-of-staff-agent-api`) via `lib/constructs/metrics-dashboard.ts`.
The API Lambda emits all three metrics through Powertools Metrics (`apps/api/src/routers/health.ts`,
`apps/api/src/handler.ts`) — verified indirectly by the smoke-tested health call (which increments
`RequestProcessed` and `ProcessingDuration` on every invocation).

## Verification performed

- `pnpm turbo run lint typecheck test build` — all green (13 tasks).
- `pnpm exec tsc --noEmit -p tsconfig.json` — root CDK app (bin/, lib/, scripts/) typechecks clean.
- `pnpm exec eslint .` / `pnpm exec prettier --check .` — clean.
- `pnpm --filter @chief-of-staff/api test` — 3 Vitest cases on `getHealth` (health route handler
  logic): returns `ok:true` + ISO timestamp, logs + emits `RequestProcessed`, fresh timestamp per call.
- `just format`, `just lint`, `just type-check`, `just test`, `just build` — each run individually,
  all exit 0.
- `just deploy` — full run: `cdk deploy --all` (5/5 stacks `CREATE_COMPLETE`) → `deploy-web` (Amplify
  job `SUCCEED`) → `smoke` (`scripts/smoke.ts`, both URLs OK). Total deploy time ~141s for the CDK
  stacks; Amplify deployment ~10s after upload.
- Manual `curl` against both live URLs (see table above) confirms public reachability outside the
  `just` process too.
