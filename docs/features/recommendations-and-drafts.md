# Evidence-grounded recommendations and drafts

Status: Wave 2A implemented behind frozen contracts.

## Outcome

`@chief/agent` turns each tenant-scoped inbound communication into one immutable
action recommendation, a focused context request when confidence is
insufficient, or an explicitly blocked result for prompt injection. Reply and
acknowledgement recommendations can become cited, style-matched draft revisions
and immutable approval action plans. None of these paths can approve, send, or
mutate Asana.

`@chief/model-gateway` is the only production model-construction boundary. It
creates an explicitly configured Amazon Bedrock model through the Vercel AI SDK,
applies the Team Kit prompt-cache policy, and exposes no fallback profile.
Tests inject deterministic stored AI SDK model outputs through the same
`ToolLoopAgent` path and make no network or credential calls.

## Architecture

```text
verified inbound + server-derived scope
                 |
                 v
      prompt-injection precheck
                 |
                 v
  communications + organization + Asana
      cited retrieval boundary
                 |
                 v
     bounded read-only ToolLoopAgent
                 |
          +------+------+
          |             |
          v             v
  cited action     focused context request
          |
          v
  approved-example style profile
          |
          v
  structured fact-selection plan
          |
          v
 deterministic channel renderer
          |
          v
 immutable cited draft revision
          |
          v
 immutable approval action-plan hash
```

The model selects action types and already-authorized fact IDs. It does not
author free-form factual claims. The renderer assembles draft content from the
exact cited fact statements plus bounded non-factual greeting,
acknowledgement, context-question, and sign-off components. This is a deliberate
tradeoff: it gives up unrestricted prose generation so unsupported commitments
cannot hide in otherwise polished text.

## Retrieval and citation boundary

`CitedContextRetriever` requires exactly one source for each factual class:

- communication history;
- organization knowledge;
- Asana work context.

All three sources receive the same server-derived tenant, user, brand, scope
hash, query, and exact entity references. Results are rejected if a fact has a
different tenant/source class, an empty statement, a duplicate fact ID, or a
duplicate citation ID. The boundary sorts and caps each source, then hashes the
complete query and the three source snapshot manifests.

Durable retrieval carries each selected record's server-derived exact entity
references and typed source class into the evidence boundary. Communication
evidence must name the canonical retrieval thread identity for the source
message and a verified typed topic relation. A public UI thread alias or a
same-thread token match is not authority. Organization and Asana facts remain
separate factual classes and are admitted only when their verified relation
metadata names that canonical entity and topic. Exact-reference scoring can
improve retrieval rank; it cannot force an unrelated fact into model selection
or draft text. Legacy evaluator evidence is admitted only when source ID,
chunk, citation ID, content hash, and text all match a canonical fixture;
citation-ID-only compatibility is rejected.

For the public launch fixture, the product layer also projects the existing
SEC-4821 fixture task as a separately authorized Asana fact with the verified
release-readiness relation to the canonical launch thread identity and a
derived combined manifest hash. This preserves a
two-fact launch draft without borrowing the unrelated board communication. It
is deterministic evaluator knowledge, not a live Asana read or mutation.

Every model-selected fact ID must resolve inside that authorized context.
Unknown or duplicate IDs fail toward `request_context`; they never become
draft text or a citation. Style examples are handled separately and cannot act
as factual evidence.

## Deterministic confidence and abstention

Confidence is computed after model output from cited fact count, factual-source
diversity, missing facts, and explicit no-action policy. The model does not set
its own trusted confidence. The named `minimumActionConfidence` policy is
`0.67`: a normal action below `0.67`, any missing critical fact, invalid
citation selection, absent retrieval context, or unavailable/invalid model
output produces a focused context request. Two relevant facts from one factual
source class reach exactly `0.67`; one fact remains below policy and abstains.

Focused questions are deterministic and fact-specific. Date/deadline, owner,
and amount gaps use specialized questions; other gaps ask what the response
should say about the named fact. Each inbound therefore reaches a terminal
recommendation state even when generation is degraded.

Prompt injection is checked across both the authored segment and quoted
history before retrieval or model execution. Detected instructions produce a
blocked recommendation/context request without calling the model. The model
system instruction also labels all inbound content, retrieved facts, style
data, and revision instructions as untrusted data.

## Style profile

`learnStyleProfile` accepts only records explicitly typed as approved examples
and enforces tenant, brand, user, and channel equality. Example order is
normalized before feature extraction, so replay is stable. Profiles retain
only bounded dimensions:

- formal, conversational, or neutral tone;
- concise, balanced, or detailed length;
- greeting and sign-off families;
- emoji preference;
- channel character limit;
- approved example IDs and an immutable profile hash.

The profile never copies historical facts into a draft. With no approved
examples, the renderer uses a visibly neutral channel default rather than
claiming learned style.

Email, SMS, WhatsApp, X, LinkedIn, and generic channels have separate maximum
lengths. Email may use greeting/sign-off framing; shorter channels do not.
When selected facts exceed the channel budget, lower-priority facts are removed
with their citations. If even one fact cannot fit, the result is explicit
`CHANNEL_LIMIT` degradation rather than truncated evidence.

## Model and tool policy

Production configuration is explicit and immutable:

```ts
const gateway = createBedrockModelGateway({
  profile: {
    profileId: 'promoted-chief-generation-profile',
    modelId: 'an-enabled-bedrock-model-or-inference-profile',
    region: 'us-east-2',
    gatewayVersion: 'ai@6.0.230',
    promptPolicyHash,
    actionContextRoute: 'chief-action-v1',
    draftRoute: 'chief-draft-v1',
  },
});
```

There is no default model ID and no secondary provider/model. AWS credentials
are resolved through the standard Node provider chain only when Bedrock is
invoked. An unavailable configured model remains unavailable and the agent
returns a degraded/context state.

The `ToolLoopAgent` tool allowlist is fixed to:

- `get_cited_fact`;
- `get_style_profile`.

Both are request-local and read-only. Send, approval, and every Asana mutation
class are explicitly denied. The loop stops after four steps, AI SDK transport
retries are capped at one, and one schema-repair attempt is permitted. Failure
after that attempt is an explicit `INVALID_MODEL_OUTPUT` outcome.

Bedrock models are wrapped at construction time. Cache points are applied to
the first system message and last non-system message while preserving other
provider options. Generated and streamed cache read/write tokens can be passed
to an injected observer for Powertools/LangSmith integration without logging
content or credentials.

## Immutable revisions and approval preparation

Recommendation, draft revision, rendered payload, model profile, request,
prompt, policy, retrieval snapshot, and style profile inputs receive canonical
SHA-256 hashes. Recommendation and draft identifiers are deterministic over
their immutable inputs.

Draft creation and revision check `RecommendationHeadReader` so the expected
recommendation must still be current. Draft revision also reads the current
head through `DraftHeadReader`. The expected revision, head revision, head ID,
and supplied base must all agree before a model call. A successful edit creates revision `n + 1`, records
`supersedesRevisionId`, and changes the content/artifact hashes. A stale or
unsafe revision fails closed.

`prepareApprovalActionPlan` is proposal-only. It binds the exact connector
account, recipient digests, draft revision, rendered payload fingerprint,
policy, and expiry into the frozen `ActionPlan` contract. Execution remains the
responsibility of the separate approval/outbox lane.

## Networkless verification

Focused tests use `MockLanguageModelV3` with stored JSON outputs. They prove:

- identical fixture input produces identical recommendation, draft, and hashes;
- citations resolve to the exact selected communication/Asana facts;
- launch and board facts cannot cross their exact topical boundaries;
- two same-source facts remain usable when both are relevant, while one fact
  still abstains under `minimumActionConfidence`;
- unsupported fact IDs abstain instead of becoming prose;
- empty retrieval produces one focused request without a model call;
- prompt injection hidden in quoted history is blocked without a model call;
- one invalid-output repair is attempted, then degradation is explicit;
- draft model degradation does not silently return a canned AI success;
- approved style learning is order-stable and tenant/brand/user/channel scoped;
- email and SMS rendering follow different channel rules;
- current-head revision succeeds and stale revision fails before inference;
- the action plan binds one proposal-only send operation;
- tool allowlists contain no provider or Asana effect.

Run with Node `22.18.0`:

```powershell
$env:PATH='E:\nvm\v22.18.0;' + $env:PATH
pnpm --filter @chief/model-gateway test
pnpm --filter @chief/model-gateway lint
pnpm --filter @chief/model-gateway typecheck
pnpm --filter @chief/model-gateway build
pnpm --filter @chief/agent test
pnpm --filter @chief/agent lint
pnpm --filter @chief/agent typecheck
pnpm --filter @chief/agent build
```

These tests never read `.config`, credentials, provider exports, or network
services. Live Bedrock qualification and the promoted-profile manifest remain
separate release-gated evidence.
