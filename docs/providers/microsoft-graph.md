# Microsoft Graph email connector

Status: `selection_state=unselected_candidate`, release
`runtime_mode=disabled`. The Wave 1A implementation is deterministic,
credentialless, networkless provider-conformance evidence. It is not live
provider proof and cannot create a subscription or reach a recipient.

## Authorization contract

The connector uses Microsoft identity platform authorization code with S256
PKCE against the personal-account-capable `consumers` authority. The delegated
scope list is exact and ordered:

```text
offline_access
User.Read
Mail.Read
Mail.Send
```

No `Mail.ReadWrite`, application permission, or admin-only permission is
claimed. Plain HTTP redirects are rejected except for an explicit loopback
callback. OAuth state, verifier, provider subject, encrypted refresh token,
and account binding remain server-side contracts; tokens never belong in a
URL, log, fixture, or browser storage.

Refresh rotation uses a per-account, per-credential-epoch fenced claim before
token exchange and compare-and-swap after exchange. A losing worker reloads the
new state. A crash or persistence failure after Microsoft may have rotated the
token requires reauthorization/recovery and never reuses the old token.

## Inbound contract

Message delta polling is the mandatory fail-closed path. Every request is
bounded by item/page budgets and uses `Prefer: IdType="ImmutableId"`. A delta
checkpoint advances only outside the adapter after canonical facts and the
event outbox commit. HTTP `404`/`410`, `SyncStateNotFound`, and
`InvalidDeltaToken` produce an explicit restart/reset decision rather than an
empty successful page. Rate limits and temporary failures remain retries;
authorization failures do not.

Normalization preserves:

- the immutable message ID and native `conversationId`;
- sender, from, To/Cc/Bcc/Reply-To participants;
- HTML/text body and preview;
- source timestamps and message state;
- attachment metadata plus deterministic content digest where fixture bytes
  exist;
- `Internet-Message-ID`, `In-Reply-To`, and `References` correlation.

The recorded notification fixtures cover Microsoft's validation-token echo,
strict `clientState` rejection, ordinary change notification shape, and the
`reauthorizationRequired`, `subscriptionRemoved`, and `missed` lifecycle
branches. They do not create a subscription. A future live subscription is
blocked until the release/deployment/callback proof and pre-call lease-mutation
claim required by the shared contract are present.

## Outbound and reconciliation contract

The only supported design is create-draft, persist its immutable draft ID as
the execution artifact's `provider_draft_id` client correlation, then send that
prebound draft. Bare `sendMail` fails closed. The immutable artifact also binds
the operation, attempt, approval/action revision, account, rendered-payload
hash, correlation version, and `graph-draft-sent-items@1` reconciliation
strategy before dispatch.

Microsoft HTTP `202` means `provider_accepted`; it never means delivered. The
server request ID is response evidence, not the durable message identity.
Timeouts, inconclusive responses, and post-call correlation persistence
failures become `acceptance_unknown`. Bounded Sent Items reconciliation uses
immutable IDs; an inconclusive search never enters ordinary retry.

Graph does not provide a universal email delivery receipt through this
contract. Complaint, unsubscribe, opt-out, reconsent, consent-window, and
delivered facts are therefore unsupported/unknown rather than invented.

## Deterministic verification

From the repository root with Node `22.18.0`:

```powershell
$env:Path='E:\nvm\v22.18.0;' + $env:Path
pnpm --filter @chief/connector-microsoft-graph test
pnpm --filter @chief/connector-microsoft-graph lint
pnpm --filter @chief/connector-microsoft-graph typecheck
```

The suite uses provider-shaped Graph message, delta, attachment, notification,
lifecycle, OAuth, draft-send, and Sent Items fixtures. It also runs the frozen
`@chief/connector-testkit` contract runner for descriptor/method parity,
checkpoint and subscription fencing, normalization binding, immutable effect
artifacts, correlation-before-acceptance, canonical transport states,
explicit unsupported-feedback capability truth, ambiguity, duplicate effects,
and tenant/account isolation. No test reads credentials or performs network
I/O.
