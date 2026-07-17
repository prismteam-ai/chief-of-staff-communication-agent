# Twilio SMS and WhatsApp connector

Status: provider-shaped, networkless Wave 1B implementation. No live Twilio
account, credential, webhook registration, read, send, or other provider effect
is enabled.

## Capability truth

One `@chief/connector-twilio` package owns shared request verification,
normalization, correlation, feedback, status reduction, and send-eligibility
policy. SMS and WhatsApp remain separate canonical connector descriptors:

| Connector         | Modes represented                        | Inbound webhook |            Media metadata |                                Feedback | Send/external effect |
| ----------------- | ---------------------------------------- | --------------: | ------------------------: | --------------------------------------: | -------------------: |
| `twilio-sms`      | `live_trial`, `virtual_test`, `disabled` |             Yes | Yes (MMS references only) | Status plus provider-visible STOP/START |             Disabled |
| `twilio-whatsapp` | `sandbox`, `virtual_test`, `disabled`    |             Yes |     Yes (references only) |         Status plus opt-in/window facts |             Disabled |

The mode list describes the provider modes the package can represent; it does
not certify an account or make a mode live. The Wave connector never reads a
secret reference and exposes no SPI `send` or reconciliation method. Credential
configuration fails with `TWILIO_EXTERNAL_CONFIGURATION_DISABLED`.
Subscription methods remain present for webhook method parity, but both fail
closed with typed `TWILIO_SUBSCRIPTION_MUTATION_DISABLED`; fixtures never
create or renew provider registrations.

The unchanged frozen contract runner tests the real connector descriptor and
its disabled dispatch/reconciliation paths. Its two generic effect-core control
cases use only the testkit-owned endpoint-free fixtures; the Twilio adapter is
not wrapped, does not report effect capability, and never synthesizes provider
acceptance.

Only a strict byte-recorded `virtual_test` fixture can report healthy. Unproven
SMS `live_trial` and WhatsApp `sandbox` modes report degraded with explicit
codes, and `disabled` reports failed. Those states never perform entitlement or
credential checks.

## Request verification

`signature.ts` is the single verifier for SMS, MMS, WhatsApp, and status
callbacks. It:

1. accepts the frozen `RawWebhookRequest`, not reconstructed framework fields;
2. decodes the exact base64 raw bytes as strict UTF-8 form data;
3. retains every POST field, including provider additions unknown to this
   release;
4. calculates Twilio's HMAC-SHA1 signature using the exact externally visible
   URL string and all case-sensitively sorted form fields;
5. compares signatures in constant time; and
6. returns the SHA-256 digest of the exact raw bytes for immutable persistence
   binding.

The verifier does not try alternate schemes, hosts, ports, stages, paths, or
query serializations. A reverse proxy must supply the exact URL Twilio saw.
Fixture connectors additionally admit only byte-exact recorded bodies; a
semantically equivalent reserialization is still a different fixture.

Twilio documents the signing input as the full URL (scheme, port, and query)
plus sorted POST fields and warns that callback fields may be added over time:
[Twilio webhook security](https://www.twilio.com/docs/usage/security).

## Inbound normalization and correlation

The normalizer requires provider-shaped `MessageSid`, `From`, and `To` fields,
validates the channel prefix, preserves the exact raw field map, and creates a
stable opaque conversation correlation from channel plus the sorted
participants. It does not claim a Twilio-native thread.

Inbound media preserves `NumMedia`, each `MediaUrlN`, and
`MediaContentTypeN`. The attachment record is explicitly
`fetchPolicy=never_in_connector`; the connector does not dereference provider
URLs or download content. A later authorized storage worker must apply media
authentication, size/type controls, malware scanning, and retention.

When a callback has no provider timestamp, normalization uses the verified
ingress time and marks the timestamp fact as `verified_ingress_fallback`.
Provider delivery time remains typed `unknown`; it is never invented.

## Canonical status reducer

Raw Twilio statuses are preserved and reduced through one versioned partial
order:

| Raw status                                     | Canonical transport state |
| ---------------------------------------------- | ------------------------- |
| `accepted`, `scheduled`, `queued`, `receiving` | `queued`                  |
| `sending`, `sent`, `received`                  | `provider_accepted`       |
| `delivered`, `read`                            | `delivered`               |
| `failed`, `undelivered`                        | `delivery_failed`         |
| `canceled`                                     | `provider_rejected`       |

Delayed lower-confidence callbacks cannot regress a stronger state. Exact
duplicates are idempotent; a later delivery receipt can supersede an earlier
partial failure. Bare `accepted`, `sent`, and `failed` are never returned as
canonical transport states. Twilio's current provider vocabulary is documented
on the [Message resource](https://www.twilio.com/docs/messaging/api/message-resource).

Feedback normalization binds provider event/message correlation, internal
operation and attempt IDs, exact raw digest/reference, connector snapshot, and
a tenant/account-scoped keyed idempotency digest. The shared connector-core
pipeline persists the immutable fact and event-outbox item atomically before
publication. Missing correlation remains durable replay work.

## SMS STOP and START

Only provider-visible `OptOutType=STOP` creates `provider_opt_out`; body text
alone is typed `unknown`. `OptOutType=START` creates verified re-consent only
when it explicitly supersedes the current same-scope provider opt-out fact.
This matches Advanced Opt-Out behavior while remaining truthful for accounts
where that field is not enabled. Twilio states that future sends to a blocked
recipient fail asynchronously (commonly error `21610`) and that START/UNSTOP
remove the provider block: [Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out).

Current contact policy is re-evaluated immediately before artifact preparation.
Suppressed, unknown, or stale policy denies the operation even if a draft was
previously approved.

## WhatsApp opt-in, window, and templates

An inbound message opens a 24-hour customer-service-window fact but does not by
itself create consent. A separate explicit user opt-in fact is required.
Free-form eligibility requires both current opt-in and an open window. After
the window closes, only a template with separate approval evidence is eligible;
otherwise preflight returns `customer_service_window_closed`.

For the Sandbox, join state remains an external provider fact and fixtures do
not claim it. Twilio documents that each participant must join, that inbound
messages open a 24-hour window, and that only approved templates can initiate
messages outside it: [WhatsApp Sandbox](https://www.twilio.com/docs/whatsapp/sandbox),
[error 63016](https://www.twilio.com/docs/api/errors/63016).

Even after successful eligibility, `prepareTwilioEffectArtifact` returns only
the unchanged immutable artifact plus an explicit
`externalEffect=false/providerRequestCreated=false` receipt. No provider
payload, recipient endpoint, or Twilio client is created.

## Deterministic verification

All fixtures are visibly synthetic, form-urlencoded provider byte shapes using
`.invalid` URLs and non-provider signing material supplied directly by tests.
They are networkless and cannot target a real recipient.

Run with Node `22.18.0`:

```text
pnpm --filter @chief/connector-twilio test
pnpm --filter @chief/connector-twilio lint
pnpm --filter @chief/connector-twilio typecheck
pnpm --filter @chief/connector-twilio build
```

The test suite covers exact URL/raw-byte verification, inbound media, duplicate
and out-of-order callbacks, partial callback ordering, SMS STOP/START and
current suppression, WhatsApp opt-in/window/template eligibility,
send-after-suppression/window denial, account isolation, typed unknown facts,
and both SMS and WhatsApp runs through `@chief/connector-testkit`.
