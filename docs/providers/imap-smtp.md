# Generic IMAP/SMTP provider

Status: `selection_state=fallback_candidate`, `runtime_mode=disabled`, not live-certified.

The generic mailbox adapter is a provider-neutral fallback for a paid or otherwise verified mailbox when the Microsoft Graph candidate is not selected. It implements the frozen `CommunicationConnector` SPI through subpath modules under `@chief/connector-imap-smtp/*`; the package's frozen scaffold metadata and root barrel remain unchanged.

## Capability truth

The implementation descriptor declares protocol capability, not current account enablement:

- IMAP read, bounded polling/backfill, MIME attachments, reconstructed reply threads, and multiple accounts are implemented;
- SMTP send and bounded Sent-folder reconciliation are implemented behind the immutable effect artifact;
- RFC 3464 DSN delivery/bounce parsing is provider-dependent fixture/protocol evidence;
- complaints, unsubscribe, opt-out, reconsent, and consent-window facts are `unknown` unless the selected provider later proves them;
- there is no webhook capability and no native provider thread claim;
- no account becomes selectable or effect-capable until a current release-bound decision and live certification change its server-owned snapshot.

SMTP `provider_accepted` means only that a conclusive final 2xx reply and a real server-provided correlation were observed. It never means delivered. The frozen shared SPI requires provider correlation for `provider_accepted`, so even a conclusive 2xx remains `acceptance_unknown` when the server exposes no queue or equivalent correlation ID.

## Credential and transport boundary

Connection setup accepts only an opaque `kms-envelope-mailbox-credential` reference. It does not accept or return a password, access token, refresh token, or mailbox address as authority. The initial account is always disabled and remains `fallback_candidate`.

Both IMAP and SMTP require one explicit TLS mode:

- implicit TLS; or
- mandatory STARTTLS with downgrade forbidden.

Certificate validation, hostname/server-name equality, and TLS 1.2 or newer are mandatory. Plaintext fallback, disabled certificate checks, and authentication before a required TLS upgrade are invalid configurations. The GreenMail-compatible options builder maps those invariants to an injected wire harness without opening a socket itself.

## Inbound/checkpoint behavior

Each folder owns a bounded checkpoint containing folder, `UIDVALIDITY`, next UID, and highest observed UID. A poll:

1. connects through the injected strict-TLS session;
2. selects the exact folder;
3. compares `UIDVALIDITY` before fetching;
4. returns `reset_required` with UID 1 and no messages if validity changed;
5. fetches, sorts, deduplicates, and bounds UIDs;
6. returns the proposed next checkpoint for connector core to commit only after canonical writes and the event outbox commit.

Reconnects are explicit and bounded (maximum three). Every attempted session closes in a `finally` path. Folder or account substitution fails closed.

MIME normalization is deterministic for the same bytes. It preserves the raw SHA-256, message/reply/reference IDs, participants, timestamp, text/HTML, and attachment byte hashes. A thread root is reconstructed from the first `References` value, then `In-Reply-To`, then the message's own ID. This is never labeled a native thread.

## Outbound correlation and ambiguity

Before SMTP `DATA`, the adapter loads the immutable rendered bytes and verifies/persists:

- deterministic RFC 5322 `Message-ID` from `artifact.clientCorrelation`;
- envelope fingerprint (canonical MAIL FROM plus sorted/deduplicated recipients);
- internal operation and attempt IDs;
- SHA-256 of the exact rendered bytes, equal to `renderedPayloadFingerprint`;
- `correlationBindingVersion`.

Only after `persistPreDataBinding` resolves may the injected port call `submitData`. A server queue ID, when actually present, is stored separately from the client Message-ID. A conclusive final 2xx with a real server queue/correlation ID is `provider_accepted`; a conclusive failure is `provider_rejected`; timeout, disconnect, malformed final reply after DATA, or a 2xx without a real provider correlation is `acceptance_unknown`. The exact 2xx response remains available only through `providerResponseHash`; the adapter never invents a queue ID or substitutes the client Message-ID.

`acceptance_unknown` never enters ordinary retry. Reconciliation performs a bounded Sent-folder query and requires exactly one match across Message-ID, envelope fingerprint, and rendered-payload hash. No match remains unknown unless the provider can prove non-acceptance; multiple strong matches remain ambiguous. Any accepted Sent match uses folder, `UIDVALIDITY`, and UID as provider correlation.

## Protocol evidence and limitations

The repository currently contains no frozen GreenMail/Testcontainers service or image digest. This wave therefore uses:

- a GreenMail-compatible injected real-wire boundary;
- byte-exact RFC 5322/MIME and RFC 3464 DSN fixtures;
- deterministic, credentialless, networkless contract tests;
- the unchanged shared connector contract runner.

This is protocol/contract evidence only. It does not claim a live provider, successful authentication, real TCP/TLS behavior, a real send, a real Sent-folder match, or live feedback. A later live-certification task must add the approved paid/verified mailbox and separately record real-wire evidence without changing these domain boundaries.

## Verification

With Node `22.18.0` first on `PATH`:

```text
pnpm --filter @chief/connector-imap-smtp test
pnpm --filter @chief/connector-imap-smtp lint
pnpm --filter @chief/connector-imap-smtp typecheck
pnpm --filter @chief/connector-imap-smtp build
```

Tests cover TLS downgrade/certificate/secret-reference rejection, UID bounds and reset, reconnect cleanup, byte-exact MIME/attachments/reply headers, DSN normalization, pre-DATA ordering, distinct client/server correlation, accepted/rejected/unknown SMTP outcomes, strong/ambiguous Sent reconciliation, cross-tenant denial, and the full `@chief/connector-testkit` provider contract.
