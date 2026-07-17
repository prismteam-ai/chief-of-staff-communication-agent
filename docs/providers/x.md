# X connector

This package deliberately models two different messaging products. `x_legacy_dm`
is the legacy unencrypted v2 Direct Message surface. `xchat_encrypted` is a
separate encrypted capability and remains `blocked_external_access` until its
own account entitlement, read/history contract, send contract, and webhook
contract are proven.

## Runtime truth

| Capability        | Runtime                   | Read/history                                                                                                 | Send                                                                                                 | Activity namespace                                     |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `x_legacy_dm`     | `fixture` by default      | Networkless recorded v2 lookup fixtures; bounded to the documented recent-history horizon of at most 30 days | No provider call; only an `EffectExecutionArtifact`-bound, `effect_disabled` manage-request artifact | `dm.received`, `dm.sent`, `dm.read`                    |
| `xchat_encrypted` | `blocked_external_access` | `unknown`; legacy lookup and cursors do not apply                                                            | `unknown`; legacy manage endpoints do not apply                                                      | `chat.received`, `chat.sent`, `chat.conversation_join` |

The two capabilities do not share scopes, cursors, histories, plaintext claims,
or acceptance evidence. A `chat.*` event passed to the legacy parser, or a
`dm.*` event passed to the encrypted parser, returns a typed `unknown`
unsupported result.

## Legacy authorization metadata

The legacy descriptor records OAuth 2.0 Authorization Code + PKCE metadata for
audience `https://api.x.com/` and exact scopes:

```text
tweet.read users.read dm.read dm.write offline.access
```

The fixture connector can deterministically construct the authorization URL so
PKCE/scope behavior is testable. Token exchange always throws
`X_OAUTH_TOKEN_EXCHANGE_DISABLED`; it never reads a client secret, exchanges a
code, tests an entitlement, or contacts X. XChat uses the `external` connection
strategy with no legacy OAuth scopes.

## Lookup, polling, and cost gates

Provider-shaped lookup request builders cover the account event feed, a
conversation feed, and a participant conversation feed. Responses preserve
the v2 `data`, `includes`, and `meta.next_token` shapes. Stored fixture cursors
are prefixed `xlegacy:`; an `xchat:` cursor is rejected before processing.

Polling applies all of these gates before normalization:

- frozen connector-account, tenant, resource-scope, adapter-version, and
  checkpoint epoch binding from the shared SPI;
- positive remaining request budget;
- bounded resource count and USD ceiling;
- at most the request's `maxItems`/`maxPages`;
- deterministic provider-event deduplication;
- explicit exclusion/counting of records outside the 30-day horizon.

The fixture profile uses the planning baseline of USD `0.010` per returned DM
resource only as test input. Pricing is not treated as current live authority.
No balance, billing page, entitlement, or provider endpoint is queried.

## Manage and correlation

`buildLegacyDmSendArtifact` accepts only the frozen
`EffectExecutionArtifact`. It verifies tenant/account/connector bindings,
requires `client_reference` correlation and the
`x_legacy_dm_lookup` reconciliation strategy, and returns:

- the exact provider-shaped POST path/body;
- the pre-dispatch operation, attempt, idempotency, correlation, binding
  version, and rendered-payload fingerprint;
- `execution: effect_disabled`.

The communication connector itself advertises `send=false` and
`externalEffect=false` and exposes neither `send` nor `reconcileSend`. It can
therefore never persist `provider_accepted`, `sent`, or another synthetic
transport state. A future live adapter must use the shared effect sink so
correlation is durable before `provider_accepted`; timeout or post-call binding
failure must remain canonical `acceptance_unknown` and deny ordinary retry.

## Fixtures and verification

Fixtures are literal provider-shaped JSON byte strings. Tests decode the bytes
back to the exact source string, validate malformed shapes, cover duplicate and
out-of-horizon events, exercise `dm.*` versus `chat.*`, and run both the legacy
fixture connector and blocked encrypted connector through
`@chief/connector-testkit`.

The package imports no provider SDK, has no endpoint client, reads no
credentials or environment files, and performs no network request, OAuth token
exchange, webhook/subscription mutation, entitlement check, send, or spend.
