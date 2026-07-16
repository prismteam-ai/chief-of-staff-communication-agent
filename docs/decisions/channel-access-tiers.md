# Decision Record — Channel Access Tiers

## 1. Context

The assignment requires integrations for email across brands (Gmail plus additional providers),
SMS, WhatsApp, X, and LinkedIn, behind a modular connector architecture (README L13-L20), and a
demonstration of end-to-end ingestion from multiple channels (README L43). The platforms grant an
independent integrator very different levels of API access today, and the assignment also weighs
speed of delivery and the ability to make and explain tradeoffs.

## 2. Decision

Ship **every** channel as a connector implementing the same interface, and be explicit about the
access level each platform actually grants:

| Tier | Channels | Access |
|---|---|---|
| Live | Gmail · SMS (Twilio) · second email provider (generic IMAP, demoed on a named Outlook account) · X (xAI Live Search, read-only) | Real APIs, live ingestion |
| Sandbox | WhatsApp (Twilio sandbox) | Real protocol, sandbox account |
| Constrained | LinkedIn (notification-derived, read-only) | Live via real LinkedIn notification emails through the email connector + fixture-verified connector tests |

The dashboard labels each channel's provenance (live / sandbox / fixture) honestly.

## 3. Rationale

- **LinkedIn:** the messaging API is restricted to approved partners; there is no self-service path
  to programmatic member-message access within the assignment window. The pragmatic lawful signal
  source is LinkedIn's own notification emails, parsed by the email connector into LinkedIn-channel
  messages — read-only by nature.
- **WhatsApp:** production access requires Meta business verification, which does not reliably fit
  the assignment window; the Twilio sandbox exercises the same inbound/outbound protocol against a
  real WhatsApp client.
- **X:** first-party inbox/DM APIs sit behind paid tiers and do not cover the executive-mention use
  case economically. xAI Live Search reads public posts/mentions live; returned post ids are
  citation-verified and deduplicated. It is **data acquisition only** — the xAI model is invoked
  through the Vercel AI SDK solely to execute the search tool; all reasoning, recommendation, and
  drafting stay on Amazon Bedrock. DMs are out of scope and documented as such.
- **Modularity is the tested capability (README L20):** a connector architecture where four live/
  sandbox channels and two constrained channels all flow through one pipeline demonstrates that a
  future channel — or an upgraded access level — is a connector swap, not a rebuild.

## 4. Delivered scope

All six channel ACs are delivered as code against one interface; live ingestion is demonstrated
from Gmail, SMS, a second email provider, and X; WhatsApp is demonstrated in sandbox; LinkedIn is
demonstrated live from real notification emails (reply/send remains impossible on this path) plus
recorded fixtures for connector tests. Cross-channel linking and the dashboard channel breakdown
include every tier.

## 5. Consequences

- X and LinkedIn connectors are read-only: recommendations for them produce drafts routed to a
  sendable channel or exported, never an automated post/reply.
- The WhatsApp sandbox requires the demo participant to join via the sandbox code; session windows
  apply.
- Twilio trial-account constraints (verified recipients, message prefix), if not upgraded, are
  stated in the demo.

## 6. Conditions for full integration

- LinkedIn: acceptance into the partner messaging program → replace the notification-derived
  connector with the API connector behind the same interface.
- WhatsApp: completed Meta business verification → move the connector from sandbox to a production
  sender.
- X: an API tier with DM/mention read access → extend the connector beyond public posts.

## 7. Amendment (Task 9) — SMS deprioritized in favor of WhatsApp sandbox as the second live channel

The Live tier above lists SMS via Twilio as originally planned; at implementation time it was
deprioritized for the second-channel milestone in favor of WhatsApp (already Sandbox-tier here) —
the actual delivered basis for README L43's "multiple channels" closure — for one concrete reason:

- **US A2P 10DLC registration is a multi-day-to-multi-week carrier approval process** (campaign
  registration + brand vetting) before a Twilio SMS number can send/receive traffic reliably in the
  US. That does not fit the assignment window, and there is no sandbox-equivalent bypass for SMS the
  way there is for WhatsApp — Twilio's WhatsApp sandbox is immediately usable with the SAME Twilio
  account, no carrier approval, against a real WhatsApp client.
- The WhatsApp sandbox is not a lesser proof of the connector architecture: it exercises the same
  bidirectional protocol (inbound webhook + outbound REST send) through the identical `Connector`
  interface (`ingest`/`send`/`identity`) every other channel implements, and Twilio's REST API shape
  (Messages resource, signature-verified webhooks, provider-message-id correlation) is what SMS
  would have used too — swapping the sandbox WhatsApp sender for a registered SMS number, or for a
  production WhatsApp sender post-Meta-verification, is a credential/endpoint change, not a
  connector rewrite (the same "connector swap, not a rebuild" property §3's Rationale claims for
  every channel here).
- SMS remains listed above as the originally-scoped Live-tier channel and stays a valid future
  addition once A2P 10DLC registration completes; it is not implemented in this delivery.
