# Hosted evaluator demo

The reproducible demo runs the same non-skippable authenticated vertical as
hosted acceptance and records the browser page after Cognito authentication:

1. load the durable launch thread;
2. inspect source-owned citations and confirm related Asana is empty;
3. create or reload immutable concise revision 2;
4. approve that exact revision and display its durable `effect_disabled`
   receipt;
5. reload the thread and exact approval deep link;
6. verify API status and MCP protocol parity with no direct-effect tool.

Set the same private hosted environment variables described in
[evaluator E2E](../testing/evaluator-e2e.md), then run:

```powershell
pnpm --filter @chief/e2e demo:hosted
```

Playwright writes the video beneath
`apps/e2e/node_modules/.cache/playwright-hosted-demo/`. The generated recording
is intentionally not the authority for pass/fail; the assertions in
`hosted-durable.spec.ts` remain the executable proof. The checked-in demo copy
contains no credential value or provider payload:
[chief-hosted-evaluator.webm](chief-hosted-evaluator.webm).
