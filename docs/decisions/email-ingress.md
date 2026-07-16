# Decision Record — Channel Ingress for the Agent Runtime

## 1. Context

The kit's agent runtime pattern (`build-ai-agents`, agent `ash`) is built around Asana-task ingress:
the Chat SDK with the Asana adapter receives webhooks, and its DynamoDB state adapter provides
thread subscriptions, distributed locks, and webhook dedupe. This assignment's agent is triggered by
**inbound communications** (email first), and the kit has no inbound-channel ingestion capability —
its communication-activity skill covers outbound dispatch and delivery feedback, where an unsolicited
inbound message has no prior send to correlate with.

## 2. Decision

Keep the kit's agent **interior** exactly as prescribed — Amazon Bedrock through the Vercel AI SDK
`ToolLoopAgent` with prompt caching, conversation history in AgentCore Memory behind a
`ConversationEventStore`, LangSmith telemetry, typed multi-intent tool contracts — and replace the
**ingress** with the channel-connector pipeline: webhook/poller → SQS → processor → agent. Asana
remains in the architecture as the **action sink** (task linking, creation, updates), not as the
trigger.

## 3. Rationale

- The agent interior is cleanly separable: its interfaces take plain identifiers (session, actor,
  event tokens), so an email-derived identity (thread key, sender, provider message id) drops in
  without touching the model, tools, memory, or telemetry layers.
- The alternative — bridging every inbound communication into an Asana task so the stock Asana
  ingress could fire — was considered and rejected: it forces every message (including
  dismiss-worthy noise) through Asana, adds a hop against the <5-minute goal, and misuses task
  semantics as a message queue.
- The Chat SDK's state adapter does not transfer without its Asana webhook context, so ingress-level
  idempotency is re-provided explicitly (see consequences).

## 4. Delivered scope

The full agent runtime with the kit-prescribed interior; connector-driven ingress for every channel
tier; Asana as a first-class action sink with approval-gated writes.

## 5. Consequences

- **Idempotency is owned by the ingress:** dedupe on the provider message id via DynamoDB
  conditional writes, plus idempotent memory-event tokens derived from the same id — a retried or
  duplicated delivery neither reprocesses the message nor double-writes history.
- **Concurrency:** per-thread ordering is enforced at the processor level rather than by the Chat
  SDK's distributed locks.
- The deviation is confined to ingress. The **send half** of the loop — provider send handoff, send
  idempotency, delivery-confirmation ingestion, activity closure — IS governed by the
  communication-activity skill and is driven by it in the plan (Tasks 6 and 9); only unsolicited
  inbound acquisition is outside the kit.
- A future Asana-triggered surface (e.g. mention-driven workflows) can be added alongside without
  rework, using the stock adapter.

## 6. Conditions for revisiting

If the kit gains an inbound-channel ingress capability, the connector pipeline's processor is the
single integration point to swap onto it.
