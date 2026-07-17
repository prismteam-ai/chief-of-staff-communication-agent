# Team Kit operational applicability and exceptions

The machine-readable source of truth is
`config/team-kit-applicability/registry.json`. Its dependency-free validator
requires exactly the eight named capabilities, one allowed state per entry,
an owner, evidence, a reconsideration/closure trigger, data-handling impact,
release consequence, and `liveConformanceClaimed: false`.

These states are applicability decisions, not runtime status. `adopted` or
`adapted` never means an integration is live without later implementation and
runtime evidence. `exception_pending` fails closed for the release claim named
by that entry. No local stub substitutes for an unavailable organization
integration.

## Decisions

| Capability | State | Rationale | Release boundary |
|---|---|---|---|
| Shared CI/CD | `adapted` | Preserve Team Kit's six-recipe interface, but the assessment pull-request path is validation-only. It receives no secrets/OIDC and cannot deploy. | Claim validation-only CI only after COS-015/COS-019 implement and exercise it; do not claim the organization workflow is live from this record. |
| Lexicon | `exception_pending` | Metric registration is mandatory in Team Kit, but external repository authority is unverified and no application metric exists in this wave. | Close access/exception before metric release or disclose the explicit conformance limitation. |
| Main Dashboard | `exception_pending` | Every metric also needs a dashboard widget, but external authority is unverified. | No full Golden Path observability claim without verified widget coverage or separately approved exception. |
| PagerDuty | `exception_pending` | Team Kit requires production paging and one self-resolving alarm per DLQ; service/routing ownership is not verified. | Effect-capable production paths cannot claim full conformance until trigger/resolve evidence exists. |
| AWS OIDC | `exception_pending` | Validation-only CI intentionally has no OIDC; account, trust, role, qualifier, and deployment authority remain gated. | CI deployment and OIDC claims are prohibited while pending. |
| LangSmith | `exception_pending` | Compatibility, account access, field redaction, retention/deletion, and data-processing approval are unresolved. | Trace export stays disabled and CloudWatch is not mislabeled as equivalent. |
| Chat SDK | `not_applicable` | Core ingress starts at communication providers; Asana is a `WorkManagementConnector`, not an Asana-triggered chat surface. | Do not claim Chat SDK use. Reassess if such a surface is approved. |
| AgentCore Memory | `not_applicable` | Canonical messages/threads plus authorized RAG are the communication system of record; no separate chat-session memory is selected. | Do not claim AgentCore Memory use. Reassess with retention/tenancy/source-of-truth review if session state is introduced. |

## Data-handling rule

Operational integrations receive only the minimum safe metadata needed for
their purpose. Metrics, dashboards, and incidents exclude executive message
content, attachments, raw personal identifiers, provider tokens, and routing
keys. LangSmith receives no trace until an explicit field allowlist and
retention/deletion contract pass. OIDC uses short-lived audience-bound identity
and never a static access-key export.

## Validation

Run with Node 22:

```text
node config/team-kit-applicability/validate.mjs --format text
```

The validator rejects missing/extra entries, invalid or duplicate IDs, unknown
states, empty evidence/owner/trigger/impact/consequence fields, a pending
exception without fail-closed release wording, a `not_applicable` entry that
still expects access, and any live-conformance claim.
