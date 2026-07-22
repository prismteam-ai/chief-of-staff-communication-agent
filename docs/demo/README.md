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
[chief-hosted-evaluator.mp4](chief-hosted-evaluator.mp4).

## Real LinkedIn archive acceptance

`linkedin-archive-acceptance.json` is the output of the shipped LinkedIn archive
importer run against a **real** LinkedIn data export (8.2 MB), not a fixture:

| | |
|---|---|
| Status | `pass` |
| Conversations | 3,870 |
| Participants | 7,749 |
| Messages | 11,249 |
| Attachments | 168 |
| Malformed rows | 110 (tolerated and reported, not silently dropped) |
| Admitted to retrieval | **`false`** |

Reproduce it with:

```
node packages/connector-linkedin/dist/archive-acceptance-cli.js <path-to-export.zip>
```

No network call, no credential and no feature flag is involved.

**The refusal is the point.** The archive parses cleanly and then the importer
declines to admit it to the retrieval index, because 11,249 messages exceeds the
bounded profile hard stop of 10,000. It reports
`requires_bounded_preselection_or_opensearch_promotion` rather than silently
truncating the archive or silently ingesting it.

**Only aggregate counts and content hashes are recorded.** No message body, no
participant name, no phone number and no per-record field appears in this file or
anywhere else in the repository. The export contains thousands of real messages
involving third parties who did not consent to their inclusion, so the hosted
evaluator tenant uses a schema-exact synthetic archive instead, and the real export
is never ingested, never published and never shown on camera.
