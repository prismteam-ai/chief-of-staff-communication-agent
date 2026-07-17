# Gmail connector

The Gmail adapter is an OAuth connector with mandatory fenced `history.list`
polling/backfill. Pub/Sub is deliberately a separate disabled capability until
the hosted callback, topic IAM, watch creation/renewal, notification
verification, and push-to-history gap recovery are proven for the deployed
release.

## Authorization

The adapter requests exactly:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.send`

Authorization uses code flow with PKCE (`S256`), the configured non-secret
OAuth client ID, explicit consent, and offline access. Completion rejects
audience or granted-scope drift. The package
does not request `gmail.modify`. OAuth code exchange, token envelope storage,
refresh-token fencing/CAS, and account identity digesting are supplied by the
credential boundary; the connector receives only a tenant-bound
`ConnectorAccount` and never logs or returns token material.

## Inbound contract

Initial/reset backfill first captures the mailbox's current `historyId` as a
fence, then walks bounded `messages.list` pages and fetches each full message.
Continuation pages retain that original fence. After all backfill canonical
writes commit, `history.list` resumes from the fence so messages arriving
during the backfill cannot fall into a gap.

One fenced `SyncCheckpoint` then owns the opaque Gmail `historyId`. Each poll is
bounded by the SPI's item/page budgets, calls `history.list`, deduplicates
`messagesAdded`, fetches full provider messages, and returns canonical facts.
The caller advances the checkpoint only after canonical writes and event
outbox persistence. A stale/expired history ID raises
`GMAIL_HISTORY_RESET_REQUIRED`; the scheduler must run its bounded full
backfill/reset path rather than inventing continuity.

Full-message normalization preserves Gmail message/thread IDs, participants,
subject, plain/HTML bodies, labels, attachment IDs/metadata, and RFC 5322
`Message-ID`, `In-Reply-To`, and `References` reply facts. Raw bodies stay in
the private raw-body reference named by the canonical envelope.

## Outbound and reconciliation

The adapter accepts only the frozen `EffectExecutionArtifact`. Before provider
dispatch, the artifact must already bind a deterministic RFC 5322 `Message-ID`,
rendered-payload fingerprint, operation/attempt IDs, approval/revision refs,
and correlation version `1`. Prepared MIME lookup is content-hash bound and is
outside this package's credentialless contract tests.

An accepted Gmail API response is a provider acceptance fact, never delivery.
Both Gmail message ID and thread ID must be present; they are returned as one
atomic provider correlation for connector-core to persist before
`provider_accepted`. Missing correlation, timeout, or a post-call persistence
failure produces `acceptance_unknown`.

Reconciliation is bounded Sent-mail lookup by the prebound RFC 5322
`Message-ID`. Exactly one match resolves acceptance. Zero or multiple matches
remain `acceptance_unknown`; connector core denies ordinary retry. Gmail does
not claim universal delivery, bounce, complaint, or unsubscribe feedback, so
those facts remain typed unsupported/unknown.

## Verification and safety

The co-located Vitest suite uses byte/provider-shaped, deterministic fixtures
and the unchanged `@chief/connector-testkit` contract runner. It has no
credentials, recipient addresses are `.invalid`, and its injected gateways
have no network authority. No provider, OAuth, webhook, Pub/Sub, mailbox, or
AWS mutation occurs during tests.

Run with Node `22.18.0`:

```sh
pnpm --filter @chief/connector-gmail test
pnpm --filter @chief/connector-gmail lint
pnpm --filter @chief/connector-gmail typecheck
```
