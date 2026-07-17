# Approval-gated effect execution

Status: Wave 2B implementation.

## Outcome

The execution worker consumes an immutable approved operation, conditionally
claims its outbox record, revalidates current authority and recipient policy,
persists the pre-dispatch attempt and client correlation, and then either:

- writes a truthful, networkless `effect_disabled` receipt; or
- invokes one exact injected communication/Asana adapter under a matching
  server-owned runtime policy.

No request or SQS body can select a tenant, account, connector, endpoint, or
credential. Queue messages contain only an internal operation ID; server
configuration supplies time, worker identity, and lease duration. The
authoritative DynamoDB-backed persistence adapter
resolves every tenant/account/payload/revision binding server-side through the
frozen `ApprovalExecutionPersistence` contract.

## Execution sequence

```text
SQS record (operationId only)
  -> conditional outbox claim (owner + monotonically increasing epoch + lease)
  -> load authoritative action plan / approval / artifact / account / policy
  -> frozen Wave 1 approval and artifact guard
  -> exact runtime-policy and connector capability check
  -> initial server-side recipient/account/effect-switch recheck
  -> persist dispatch attempt and typed client correlation
  -> heartbeat the exact owner/epoch lease
  -> final recipient/account/effect-switch recheck at the provider boundary
  -> persist a truthful denied/retryable uncalled outcome if that check fails
  -> effect-disabled sink OR one selected adapter call
  -> persist rejection OR correlation + provider acceptance
  -> acceptance unknown => freeze and reconcile, never ordinary retry
```

`ClaimCapturingPersistence` is a narrow decorator over the frozen persistence
contract. It captures the returned fencing epoch without changing Wave 1 and
runs the last non-effectful preflight before `persistDispatchAttempt`. A failed
preflight releases the uncalled claim. The provider sink then heartbeats that
same owner/epoch immediately and periodically. After the winning heartbeat it
repeats the authoritative recipient, suppression, consent, account capability,
and effect-switch check immediately before selecting the adapter. Losing the
lease or authority before dispatch prevents the call, while losing the lease
after dispatch freezes the attempt as unknown.

The lane-local sink records the exact instant at which control crosses into an
adapter call. A permanent policy/capability denial before that instant settles
as `pre_dispatch_denied`; a transient repository or lease failure settles as
`pre_dispatch_retryable`. `ClaimHeartbeatPersistence` persists those explicit
uncalled outcomes instead of delegating to Wave 1's unknown-acceptance path.
Only an exception or ambiguous result after the adapter boundary can enter
`acceptance_unknown` reconciliation.

Pre-dispatch reason codes are redaction-safe. Only bounded identifier codes
from explicit worker denial/retryable error types are retained; arbitrary
repository or SDK error text is replaced with a fixed generic code before it
can reach persistence, logs, or a worker response.

Wave 1 names its external `ExecutionSink` mode `provider_fake`. The Wave 2B
`GuardedProviderExecutionSink` retains that literal only for frozen interface
compatibility; it is the real injected-adapter path. The class name and this
document avoid treating that legacy discriminator as runtime truth.

## Default-off effect control

`DefaultDenyRuntimeEffectPolicy` rejects every external effect. Enabling a
controlled effect requires constructing `ExactEnvelopeRuntimeEffectPolicy`
with all of these immutable values:

- effect kind (`communication` or `work_management`);
- exact operation capability (`send_message`, `create_task`, `update_task`, or
  `create_comment`);
- tenant and operation ID;
- action-plan hash;
- connector account;
- connector ID and descriptor version;
- capability-snapshot hash;
- rendered-payload fingerprint.

There are no tenant-wide, provider-wide, account-wide, or wildcard grants.
The frozen execution guard additionally requires current global,
provider/account, and operation switches to be enabled, a selected
effect-capable runtime mode, an active/healthy account, the exact account state
version, current source-message revision, active approver authority, and every
recipient's unchanged `allowed` contact-policy projection.

The public fixture path injects no connector registry or runtime policy. It
uses `EffectDisabledSink`, produces no provider correlation, and cannot enter
`provider_accepted` or `delivered`.

## Correlation, ambiguity, and reconciliation

The immutable artifact already contains the stable operation/idempotency key,
attempt ID, account and approval bindings, rendered-payload hash, typed client
correlation, and reconciliation strategy. Persistence records that artifact
before dispatch. An accepted result is settled only after the provider
correlation is durably bound. After the adapter boundary is crossed, a thrown
call, timeout, unknown acceptance, lost post-dispatch lease, or accepted result
whose correlation cannot be persisted makes the attempt
`acceptance_unknown`/`reconciliation_required`.

`reconcileFrozenEffect` conditionally claims one resolver epoch. Two resolvers
cannot both query or decide the same operation. Its outcomes are deliberately
limited:

- proven accepted: settle the frozen operation with correlation;
- proven not accepted: permit a retry of the identical immutable operation
  under the still-active original approval and stable idempotency key;
- unresolved: remain frozen.

An unresolved operation never returns to ordinary SQS redrive. A consciously
requested resend remains the separate Wave 1 flow: a new action-plan revision,
new operation/idempotency key, duplicate-risk acknowledgement, and fresh
approval.

## Feedback and Asana closure

`processFeedbackClosure` composes the connector-core feedback boundary with
domain reducers. The adapter's provider-shaped event is schema/binding checked,
then its immutable fact and event-outbox item are persisted atomically before
publication. Durable replay handles uncorrelated facts or failed writes.

The projection step is idempotency-keyed by feedback fact and closes:

- accepted, delivered, delivery-failed, and bounced transport state;
- out-of-order delivery callbacks by applying the correlation-bound accepted
  bridge before the stronger delivery fact;
- complaint, unsubscribe, provider opt-out, bounce, and consent-window closure
  into current suppression policy;
- verified re-consent and window reopening through the domain authority rules;
- replies into answered state.

An accepted work-management result persists its provider correlation as the
communication-to-Asana linkage. Message and Asana operations remain separate
outbox records, so an Asana failure cannot cause a communication resend.

## Lambda/SQS behavior

`createExecutionWorkerLambda` supplies AWS Lambda's partial batch response.
Records run independently and only rejected records appear in
`batchItemFailures`. A malformed, oversized, or authority-bearing poison
record cannot block valid siblings. Duplicate, contended, settled, and frozen
operations are safe acknowledgements because the authoritative state already
decides their disposition.

A permanent `pre_dispatch_denied` result is also acknowledged because its
blocked/invalidated outcome is durable and the adapter was never called. A
`pre_dispatch_retryable` result becomes a partial-batch failure so transient
preflight infrastructure failures redrive without any duplicate-effect risk.

The exported module-level `handler` is deliberately unconfigured and returns
every record as failed. Deployment composition must inject:

1. the DynamoDB-backed `ClaimHeartbeatPersistence` adapter;
2. a clock and stable worker ID;
3. no provider configuration for the public effect-disabled worker; or
4. an exact runtime policy plus constructor-injected connector registry for a
   separately authorized controlled-effect worker.

This fail-closed bootstrap prevents a missing deployment binding from silently
acknowledging or performing work.

The persistence adapter must conditionally implement both
`settlePreDispatchDenied` and `settlePreDispatchRetryable` against the exact
claim owner/epoch. The former records a durable blocked/invalidated terminal
fact; the latter records retryable-but-uncalled and releases only that fenced
attempt for safe redrive.

## Tradeoffs

- The worker reuses the frozen approval/outbox and domain contracts rather
  than introducing a second state machine. The extra persistence decorator is
  the smallest boundary needed for lease heartbeat and immediate preflight.
- Provider adapters remain constructor-injected. This keeps tests networkless
  and prevents credentials/default endpoints from appearing in worker code,
  but deployment composition must supply a fully configured adapter.
- Partial-batch processing uses bounded parallelism equal to the configured
  SQS batch (maximum ten here). Provider rate and concurrency limits remain an
  infrastructure/runtime-policy responsibility; a queue message cannot
  override them.
- Reconciliation may leave work frozen for human review. That is preferable to
  an ordinary retry that could duplicate an executive message or task.

## Focused verification

The lane test suite is deterministic and performs no network, cloud, provider,
or Asana effect. It covers:

- truthful effect-disabled execution and duplicate delivery;
- exact provider correlation ordering and default-deny policy;
- stale/revoked approval, edited action plan, new inbound message, suppression,
  and cross-account substitution;
- heartbeat/epoch loss and ambiguous acceptance;
- post-correlation suppression races and transient final-boundary failures
  without false unknown-acceptance records;
- poison and partial SQS batches plus tenant/account authority smuggling;
- two-resolver races, proven non-acceptance, and unresolved reconciliation;
- delivery ordering, bounce/opt-out/unsubscribe/complaint/window policy,
  verified re-consent, reply/answered closure, and Asana linkage.

Run with the repository-pinned Node `22.18.0`:

```powershell
node --version
pnpm --filter @chief/execution-worker test
pnpm --filter @chief/execution-worker lint
pnpm --filter @chief/execution-worker typecheck
pnpm --filter @chief/execution-worker build
```
