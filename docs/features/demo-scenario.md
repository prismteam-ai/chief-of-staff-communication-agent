# Deterministic Demo and Evaluation Corpus

## Purpose

`@chief/demo-fixtures` generates a non-toy, networkless corpus for the Chief dashboard, retrieval, agent, approval, and evaluator paths. The repository commits the generator and assertions, not a large generated export. A fixed seed and clock make every identifier, timestamp, body, citation, revision hash, action-plan hash, and corpus hash replayable.

The corpus is synthetic-only. Names explicitly contain `Synthetic`, addresses are opaque fixture references, and content uses reserved fixture identifiers. The validator rejects common credential shapes, non-reserved email addresses, cross-tenant references, broken citations, and manifest drift.

## Generated coverage

The default reset produces:

| Area                                     | Generated coverage |
| ---------------------------------------- | -----------------: |
| Tenants                                  |                  2 |
| Brands                                   |                  3 |
| Connector accounts                       |                 10 |
| Threads                                  |                184 |
| Normalized communications                |              1,240 |
| Attachments                              |                 36 |
| Asana projects/tasks/milestones/comments |                 66 |
| Approved outbound style examples         |                 60 |
| Edge/adversarial cases                   |                120 |

The primary evaluator tenant contains 1,120 communications across 160 threads. The second tenant is an isolation control rather than additional data visible to the evaluator.

Communication coverage includes Gmail, Microsoft Graph-shaped second-mailbox records, SMS, WhatsApp, X, LinkedIn archive import, and a generic future/demo channel. The generated states include answered, pending, overdue, and explicit no-action records. Cross-channel topic links deliberately mix reviewed exact links and ambiguous candidates.

The edge set covers prompt injection hidden in quoted history, ambiguous identities, suppression, closed consent windows, duplicate and out-of-order events, attachment limits, deletion, and cross-tenant attacks. Prompt-injection fixtures preserve the full quoted body while the authored segment remains a separate derived field.

## Capability truth

Every generated connector snapshot is `fixture` or `manual`. Every scenario capability label has `send=false` and `externalEffect=false`.

- Gmail and Microsoft Graph records exercise canonical email shapes; they do not claim a live account.
- SMS and WhatsApp records exercise channel and policy behavior; they do not claim a Twilio send.
- X is fixture-only.
- LinkedIn is a manual synthetic archive import and does not claim live inbox, read, or send access.
- The generic channel proves that corpus generation and core behavior do not branch on a closed provider enum.
- Asana objects and the proposed handoff are fixture records; the exact plan can be approved, but execution remains explicitly effect-disabled.

Live provider evidence remains a separate release concern.

## Executive scenario: Northstar launch readiness

The stable scenario ID is `northstar-launch-readiness`.

1. Open the primary Gmail-shaped inbound asking for a Friday launch-readiness commitment.
2. Retrieve three tenant-local citations: the inbound communication, the linked Asana task, and the organization rule requiring an owner and due date before an external promise.
3. Show the expected `reply` recommendation with high urgency and deterministic confidence.
4. Show the concise, direct, warm, no-emoji draft built from approved style examples. Style evidence is stored in a separate `style` corpus and never supplies facts.
5. Show that the first approval is `invalidated` after the draft edit.
6. Inspect the second immutable action plan, which binds the exact Gmail reply plus an Asana task update.
7. Show the active approval binding the second action-plan hash while the capability label still denies external effects.
8. Reconcile the expected SLA snapshot: all generated actionable records fall within five minutes and trusted-ingress-to-actionable p95 remains under the frozen 180-second system target.

The recommendation, draft, action plan, approvals, citations, expected Asana handoff, capability labels, and SLA expectations are exported together as `corpus.scenario`.

## API

```ts
import {
  assertValidDemoCorpus,
  createDemoCorpus,
  resetDemoCorpus,
  validateDemoCorpus,
} from '@chief/demo-fixtures';

const corpus = assertValidDemoCorpus(createDemoCorpus());
const report = validateDemoCorpus(corpus);

// Reset always returns the pinned seed and clock.
const reset = resetDemoCorpus();
```

`createDemoCorpus({ seed, generatedAt })` supports deterministic variants. `resetDemoCorpus()` always uses seed `20260717`, clock `2026-07-17T09:00:00.000Z`, and reset version `demo-reset-v1`. The manifest reports counts, channel coverage, and a SHA-256 over the complete generated payload. `serializeDemoCorpusManifest()` yields canonical JSON suitable for an evidence receipt.

## Validation contract

`validateDemoCorpus` checks:

- every frozen contract schema used by the corpus;
- unique identifiers and complete message/thread/attachment/source references;
- account, brand, topic, source, style, state, edge-case, and scenario tenant isolation;
- minimum count and channel/status/adversarial coverage;
- resolved factual citations and exact recommendation/draft/action-plan bindings;
- invalidated old approval plus exact-hash active approval;
- Asana handoff parity with the action plan;
- fixture-only external-effect labels;
- deterministic count and corpus-hash integrity;
- common secret patterns, non-reserved emails, and non-synthetic person labels.

The test suite also mutates a current-revision reference and proves that both referential validation and the corpus hash fail.

## Verification

Use Node `22.18.0`:

```powershell
$env:PATH='E:\nvm\v22.18.0;' + $env:PATH
corepack pnpm --filter @chief/demo-fixtures test
corepack pnpm --filter @chief/demo-fixtures lint
corepack pnpm --filter @chief/demo-fixtures typecheck
corepack pnpm --filter @chief/demo-fixtures build
```

Tests are fully networkless. They read no credentials and perform no provider, Asana, cloud, or model calls.

## Tradeoffs

- Generated records keep the repository small and make scale/count invariants executable, at the cost of inspecting bodies through the fixture API rather than checked-in JSON.
- The corpus reuses frozen operational contracts and adds only demo envelopes where no operational entity exists yet (brand display data, response labels, identity candidates, and walkthrough expectations).
- Precomputed networkless embedding metadata is represented truthfully; no vector quality or production-model claim is made by this package.
- Stable synthetic copy prioritizes repeatable evaluation over linguistic variety. Provider-shaped contract suites and live acceptance evidence remain responsible for wire-level realism.
