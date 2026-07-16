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
| Live | Gmail · SMS (Twilio) · second email provider (IMAP/Outlook) · X (xAI Live Search, read-only) | Real APIs, live ingestion |
| Sandbox | WhatsApp (Twilio sandbox) | Real protocol, sandbox account |
| Constrained | LinkedIn (notification-derived, read-only) | Fixture-verified connector |

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
demonstrated against recorded fixtures. Cross-channel linking and the dashboard channel breakdown
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
