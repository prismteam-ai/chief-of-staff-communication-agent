# Executive dashboard

## Outcome

The Chief web application is a complete, signed-out evaluator journey across a
deterministic multi-channel fixture corpus. It demonstrates the product shape
without creating an anonymous provider or Asana mutation surface.

The public flow covers:

- executive volume, pending, answered, overdue, channel, response-time, and SLA
  metrics;
- a searchable and status-filterable unified inbox;
- thread participants, chronology, attachment metadata, answered state, and
  related Asana context;
- cited recommendation, visible confidence, focused context request, explicit
  style profile, editable draft, immutable revision diff, and approval;
- an idempotent `effect_disabled` receipt, audit timeline, and prepared-only
  Asana handoff;
- connector onboarding and independent live/recorded/fixture/blocked labels;
- evaluator evidence, safety boundaries, and Cursor/remote MCP connection
  instructions.

## Runtime truth boundary

The application uses the complete `@chief/browser-api` facade as its only
hosted boundary. It uses `VITE_API_BASE_URL` when configured and otherwise
targets the current origin. Startup requests typed health, dashboard, inbox,
and connector projections together. The UI labels successful responses
`Hosted assessment fixture`; only a genuine request/schema failure selects the
separate deterministic `Local fallback fixture` corpus.

Hosted communication routes additionally use the typed detail, thread, related
Asana, recommendation, draft, context-request, revision, and Asana-proposal
methods. No direct `fetch`, persistence shape, tenant selector, or untyped
response is introduced in the web application.

All communication, recommendation, approval, execution, Asana, metric, and
connector records currently shown in the signed-out experience are
deterministic fixtures. A healthy hosted API never relabels them as live.
Likewise, recorded evidence is not described as a current live connection, and
blocked connectors do not expose functional setup buttons. SMS evidence is
explicitly a synthetic byte-recorded/provider-shaped fixture: it is not a
Twilio receipt, signed live event, callback, or invented event time.

## Routes and deep links

The static React application uses these browser routes:

| Route                | Evaluator purpose                                               |
| -------------------- | --------------------------------------------------------------- |
| `/overview`          | Executive summary, priority queue, SLA, channel mix, audit      |
| `/inbox`             | Searchable and filterable unified communications                |
| `/inbox/:fixture-id` | Exact selected communication/thread or honest unavailable state |
| `/approvals`         | Explicit action-plan review and approval state                  |
| `/connections`       | Onboarding, health, and capability truth                        |
| `/evidence`          | Repeatable proof guide, boundaries, and MCP setup               |

`/` redirects to `/overview`. CloudFront must return the application entry point
for unknown static object paths so direct navigation and refresh of these routes
reach the client router. Provider OAuth callbacks remain API routes and must not
use this fallback.

The local fallback retains `/inbox/thread-q3-launch` as its rich deterministic
approval demonstration. Hosted IDs combine the exact thread and message
revision so multiple messages in one thread do not collide. Any unknown route
shows an unavailable state and never substitutes the Taylor/Q3 example.

## Approval ceremony

The evaluator starts with draft revision 1. Approval is disabled until the user
explicitly prepares immutable revision 2. The interface then shows the
before/after diff and states that revision 1 approval is invalid. The review
surface binds channel/account, fixture recipient, exact revision hash, message
effect, and Asana effect before enabling approval.

The hosted public API exposes bounded read and proposal-preparation operations.
It deliberately exposes no human approval or external mutation authority. The
UI says this immediately above the local ceremony. Approval creates a visible
local fixture receipt through the following semantics:

1. exact revision approval is recorded;
2. one outbox operation is claimed;
3. preflight observes the external-effect switch is off;
4. the credentialless fixture sink persists `effect_disabled`;
5. repeat processing returns the same operation receipt;
6. the Asana follow-up remains prepared and the external task stays unchanged.

The UI never describes this result as provider accepted, sent, delivered, or an
Asana update.

## Design and accessibility

The interface uses a restrained dark executive-workspace system with semantic
tokens for fixture, recorded, blocked, pending, overdue, answered, and success
states. Status always includes text and an icon or chip; color is supplementary.

The implementation includes:

- semantic headings, native buttons, native search/filter controls, and an
  editable labeled textarea;
- a skip link, visible focus rings, logical DOM order, descriptive accessible
  names, and keyboard-operable routes and actions;
- a five-item adaptive navigation pattern: sidebar on large screens and bottom
  navigation on smaller screens;
- minimum 44-pixel primary controls, 16-pixel mobile inputs, and safe-area
  padding for the bottom navigation;
- layouts for 320/375-pixel mobile, tablet, desktop, and wide three-column
  thread review;
- `prefers-reduced-motion` support and no animation-dependent state;
- no emoji structural icons and one consistent Lucide outline language;
- no remote fonts, images, analytics, or runtime design dependencies.

## Tradeoffs

The approval ceremony is intentionally in-memory because the public API has no
approval mutation. This makes the evaluator path deterministic and prevents
anonymous effects, but ceremony state resets on refresh and cannot prove live
provider delivery. Live provider and Asana proof must use the separately
authenticated, preconnected controlled-recipient tenant.

Hosted read/propose state is authoritative when available; local fallback data
exists for outage resilience and is unmistakably labeled. Loading does not
temporarily substitute the local corpus. A single failure in the initial typed
projection bundle selects the coherent fallback rather than mixing hosted and
local records on one screen.

## Verification

Component tests cover same-origin hosted API selection, truthful fallback,
hosted projection rendering, per-route non-substitution, inbox filtering,
revision-before-approval enforcement, effect-disabled/Asana outcomes, and safe
MCP guidance.
The browser suite owns full route refresh, responsive, keyboard, accessibility,
console-error, asset, hosted-health, and secret-leakage acceptance.
