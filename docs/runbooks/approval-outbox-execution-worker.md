# Approval outbox and execution worker

This wave implements ADR-009 behind the frozen Chief contracts. It does not
enable an external effect. The deployed/default worker surface remains
`externalEffects: disabled`; its only executable sink is credentialless,
endpoint-free, and writes an `effect_disabled` receipt through the injected
persistence port.

## Invariants

- `ActionPlan.canonicalHash` is recalculated from canonical UTF-8 JSON with
  sorted object keys and the hash field excluded. Approval stops before any
  persistence call when the bytes differ.
- Approval requires a verified same-tenant actor with `actions:approve` and
  explicit scope over every operation account. Every send recipient digest is
  bound exactly once to an approved tenant/account/brand/channel contact-policy
  projection; work-management operations cannot carry irrelevant recipient
  policy bindings. Approval creates one immutable approval, execution intent,
  outbox item per operation,
  and `EffectExecutionArtifact` per operation through one transactional
  persistence-port call.
- The stable idempotency key is
  `sha256(tenantId, actionPlanId, operationIndex, canonical operation)`.
- A queue delivery carries only the operation ID. After a conditional claim,
  the worker reloads authoritative server-side state. Queue payloads cannot
  supply approval, account, policy, capability, or effect authority.
- Immediately before a sink call, the worker revalidates exact plan hash,
  active approval and expiry, approver authority, current thread revision,
  connector account state and snapshot, operation capability, contact-policy
  tenant/account/brand/channel/digest/state/version, immutable artifact hash,
  and all effect-switch versions.
- The effect-disabled sink is valid only when global, account, and operation
  effects are all disabled. An injected provider-shaped fake is valid only for
  a selected effect-capable runtime with all three switches enabled. No live
  connector is selected by the default worker factory.
- The dispatch attempt is durable before the sink call. Acceptance plus
  provider correlation is one persistence operation. A thrown call,
  `acceptance_unknown`, or correlation-persistence failure freezes the
  operation for reconciliation and excludes it from ordinary redrive.
- Proven provider non-acceptance may retry only a byte-identical operation
  with the same approval, operation ID, account, payload fingerprint, and
  stable idempotency key. It uses a new attempt ID. Unresolved acceptance stays
  frozen.
- A human resend after unresolved acceptance uses a new action plan, operation
  and idempotency key, authenticated duplicate-risk acknowledgement, and fresh
  approval. The old operation remains frozen.
- Message and Asana operations are claimed and settled independently. An Asana
  rejection cannot resend a previously accepted message.

## Persistence port

`ApprovalOutboxPersistence.createImmutableBundle` is the single atomic
creation boundary. `ApprovalExecutionPersistence` owns conditional
claim/lease, authoritative reload, pre-call attempt persistence, settlement,
correlation binding, and unknown-acceptance freeze. Implementations must use
the frozen persistence package and key codec; callers and connectors never
construct DynamoDB `PK`/`SK` values.

Claims are fenced by owner and monotonically increasing epoch. An expired
pre-dispatch claim may be reclaimed. An expired claim after the durable
dispatch boundary becomes `acceptance_unknown`; it must not return to the
ordinary queue.

## Crash recovery table

| Last durable boundary                             | Recovery                                                  |
| ------------------------------------------------- | --------------------------------------------------------- |
| claim only / guard complete                       | Lease expiry permits a fresh guarded claim                |
| dispatch attempt persisted, before call           | Freeze and reconcile; do not infer non-acceptance         |
| provider call returned, before result persistence | Freeze and reconcile                                      |
| correlation persistence failed                    | Freeze with `correlation_persistence_failed`              |
| result settled                                    | Duplicate delivery returns duplicate; no second sink call |

## Effect-disabled verification

Run with Node 22.18.0:

```powershell
$env:PATH = 'E:\nvm\v22.18.0;' + $env:PATH
pnpm --filter @chief/approval-outbox test
pnpm --filter @chief/execution-worker test
```

The deterministic suite spies on `globalThis.fetch`, uses no credentials or
endpoints, and proves zero provider calls from the worker factory. Provider
outcomes in fault tests come only from injected provider-shaped fakes.

## Operator response

For `acceptance_unknown`, leave the operation frozen, use the declared bounded
provider reconciliation strategy, and record one of: proven accepted, proven
not accepted, or unresolved. Never manually place the old item back on the
ordinary queue. If unresolved and the executive requests a resend, create the
new risk-acknowledged revision and approval rather than editing or reusing the
old records.
