# Gmail connector and read-only live acceptance

The production package root exports the real `GmailConnector`,
`GoogleApisGmailClient`, descriptor, normalization/backfill functions, and
`createGoogleApisGmailConnector` composition. Credential storage, OAuth
completion, protected cursor storage, captured-message persistence, and
prepared MIME loading remain explicit injected boundaries. Provider-shaped
fixtures stay test-local and are not exported as production authority.
The package manifest has no wildcard subpath export: only the production root,
the two acceptance subpaths, and the two bounded `oauth-bootstrap` subpaths are
resolvable. In particular, `provider-fixtures` and test modules cannot be
imported through the package.

The package-local live command is deliberately narrower than the connector.
Its only mode is `read_only_acceptance`; it cannot send, watch, modify, trash,
untrash, delete, or download an attachment. It permits only:

- `users.getProfile` once;
- bounded `users.history.list`;
- bounded `users.messages.list`;
- bounded `users.messages.get(format=full)` for normalization and content-free
  capture hashes.

The command defaults to five items and two pages. It rejects more than 25
items or three pages. Both the command and an API-surface guard enforce those
hard limits. Provider pagination cardinality above the requested bound fails
closed. Every googleapis Gmail request also carries `retry: false` and a fixed
10-second transport timeout. The command adds a hard 10-second wrapper around
each Gmail call, a 15-second wrapper around each OAuth refresh/token-info call,
and a 60-second overall deadline. The google-auth methods do not accept per-call
transport options, so their explicit wrapper is the bounded enforcement layer.
Only these fixed policies—not transport errors or credential content—appear in
evidence.

Pagination must make progress. History and backfill maintain separate hashes
of opaque page tokens, reject a returned input/repeated token, and bind the
trails into the checkpoint identity. Twelve unique pending tokens is the total
continuation bound per stream; a thirteenth fails closed instead of evicting an
old hash or weakening cycle detection.

## Bootstrap read-only consent once

1. In the operator-owned Google Cloud project, configure an OAuth installed or
   web application and add the controlled Gmail account as a test user when
   the consent screen is in Testing. Download the client JSON. Do not paste or
   print its client secret in a terminal, recording, ticket, or chat.
2. Register exactly
   `http://localhost:3000/api/oauth/google/callback`. The one-time command binds
   only `127.0.0.1:3000`, validates the callback Host/path/state, and requests
   only `https://www.googleapis.com/auth/gmail.readonly` with offline access,
   explicit consent, and PKCE. It has fixed Google authorization/token hosts
   and cannot request send, modify, watch, delete, profile, email, or OpenID
   authority.
3. Under the repository's already-ignored `.config` directory, keep four
   operator-only files:

   - `<gmail-oauth-client-file>.json`: the downloaded Google JSON containing
     exactly one top-level `installed` or `web` client;
   - `<gmail-refresh-token-file>`: created by the bootstrap as a raw refresh
     token with owner-restricted permissions;
   - `<gmail-expected-account-file>`: the exact controlled Gmail account
     identity;
   - `<gmail-acceptance-checkpoint-file>.json`: created and replaced by the
     command.

   Confirm the ignore rule without listing or reading those files:

   ```powershell
   git check-ignore .config/<gmail-oauth-client-file>.json
   ```

The client JSON and refresh token are separate by design. The bootstrap accepts
Google's installed-application and web-application client formats only when
the single redirect exactly matches the registered callback above. It prints a
consent URL; it opens a browser only when `--open-browser` is explicitly
present. The optional expected-account file is used as a browser-only login
hint and is omitted from terminal evidence. The existing acceptance command
then refreshes an access token in memory, validates the exact OAuth client
audience, exact read-only scope set, and expiry, and compares
`users.getProfile` to the expected account. That tokeninfo/profile validation
remains authoritative; the bootstrap does not duplicate or weaken it.

Before reading any of these files, the command resolves/canonicalizes every
file source, the checkpoint, and its stable `.tmp`/`.bak` sidecars. It rejects
exact, relative-alias, symlink-resolved, and Windows case-variant collisions.
This prevents checkpoint recovery or replacement from reading, unlinking, or
overwriting a credential source. Keep all four files at distinct paths; never
use a credential path ending in the checkpoint's `.tmp` or `.bak` name.

## Exact Node 22 bootstrap-once and acceptance-twice commands

Run from the repository root. The variables below contain paths only, not
credential values:

```powershell
$GMAIL_OAUTH_CLIENT_FILE_PATH = '.config/<gmail-oauth-client-file>.json'
$GMAIL_REFRESH_TOKEN_FILE_PATH = '.config/<gmail-refresh-token-file>'
$GMAIL_EXPECTED_ACCOUNT_FILE_PATH = '.config/<gmail-expected-account-file>'
$GMAIL_CHECKPOINT_FILE_PATH = '.config/<gmail-acceptance-checkpoint-file>.json'

& 'E:\nvm\v22.18.0\pnpm.CMD' --filter @chief/connector-gmail build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& 'E:\nvm\v22.18.0\node.exe' packages/connector-gmail/dist/oauth-bootstrap-cli.js `
  --oauth-client-file $GMAIL_OAUTH_CLIENT_FILE_PATH `
  --output-file $GMAIL_REFRESH_TOKEN_FILE_PATH `
  --expected-account-file $GMAIL_EXPECTED_ACCOUNT_FILE_PATH `
  --open-browser
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& 'E:\nvm\v22.18.0\node.exe' packages/connector-gmail/dist/acceptance-cli.js `
  --oauth-client-file $GMAIL_OAUTH_CLIENT_FILE_PATH `
  --refresh-token-file $GMAIL_REFRESH_TOKEN_FILE_PATH `
  --expected-account-file $GMAIL_EXPECTED_ACCOUNT_FILE_PATH `
  --checkpoint-file $GMAIL_CHECKPOINT_FILE_PATH `
  --max-items 5 `
  --max-pages 2
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& 'E:\nvm\v22.18.0\node.exe' packages/connector-gmail/dist/acceptance-cli.js `
  --oauth-client-file $GMAIL_OAUTH_CLIENT_FILE_PATH `
  --refresh-token-file $GMAIL_REFRESH_TOKEN_FILE_PATH `
  --expected-account-file $GMAIL_EXPECTED_ACCOUNT_FILE_PATH `
  --checkpoint-file $GMAIL_CHECKPOINT_FILE_PATH `
  --max-items 5 `
  --max-pages 2
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

The first acceptance invocation establishes the bounded checkpoint. The second
identical invocation proves restart/resume. Do not run the bootstrap a second
time against the same output path. For an intentional rotation, repeat only
the bootstrap command with `--rotate`; the old token remains in place unless a
new token has passed all response checks and the atomic replacement succeeds.

An operator-managed secret injector may provide credential contents through
environment variables instead. Pass only their names using
`--oauth-client-env <OAUTH_CLIENT_JSON_ENV_NAME>`,
`--refresh-token-env <REFRESH_TOKEN_ENV_NAME>`, and
`--expected-account-env <EXPECTED_ACCOUNT_ENV_NAME>`. A file source and an
environment source for the same input are mutually exclusive. Avoid setting a
secret through a command line that shell history records.

Re-run the same command to prove restart/resume. The local checkpoint retains
only the account/capability hashes, opaque history cursor, bounded backfill
fence/page state, bounded page-token hashes, epochs, timestamps, and a
deterministic identity hash over every continuation field. Its exact schema,
identity hash, cursor keys, cursor/watermark binding, backfill invariants, and
token trails are verified before OAuth construction or any Google call. It
contains no access/refresh token,
message/thread ID, address, subject, or body. A pending bounded backfill resumes
from its original history fence and page token. Once `backfillComplete` is
true, later invocations skip `users.messages.list` initial backfill entirely
and run only bounded history polling/message fetches. A completed run advances
the history cursor returned by the real connector.

Checkpoint replacement uses PID-independent `<checkpoint>.tmp` and
`<checkpoint>.bak` sidecars with owner-only file mode. On startup, a valid
primary is authoritative and stale valid sidecars are removed. If the primary
is missing, a valid backup is restored before a pending temporary file; on a
first-write interruption with only a complete temporary file, that file is
promoted. A malformed primary or sidecar fails closed and is not treated as a
fresh run, so recovery remains discoverable across processes and restarts.

## Evidence and failure interpretation

A passing invocation exits `0` and emits one JSON object. Its allowed evidence
is limited to:

- redacted item/profile/API-call counts;
- stable account, provider-response, normalized-set, watermark, and checkpoint
  hashes;
- observation and normalized-source timestamps;
- the exact declared Gmail audience and scopes;
- fixed no-retry and OAuth/API/overall deadline policy;
- checkpoint resumed/completed state;
- `status: "pass"` with an empty `issueCodes` array.

It never emits tokens, client secret, account identity, address, provider
message/thread ID, subject, body, MIME payload, attachment identifier/name, or
raw provider response. Attachment content is not fetched; only the normalized
attachment count contributes to evidence.

A failure exits `1` and emits only the mode, failure status, timestamp, and a
stable issue code. Important operator actions are:

| Issue code                                                                                                   | Meaning / safe response                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GMAIL_ACCEPTANCE_CLIENT_CREDENTIALS_INVALID`                                                                | Missing/malformed installed or web OAuth client source; repair the protected file without printing it.                                                                |
| `GMAIL_ACCEPTANCE_REFRESH_TOKEN_INVALID` / `GMAIL_ACCEPTANCE_TOKEN_INVALID` / `GMAIL_ACCEPTANCE_TOKEN_STALE` | Missing, revoked, invalid, or expired credential; obtain fresh consent outside logs.                                                                                  |
| `GMAIL_ACCEPTANCE_OAUTH_AUDIENCE_MISMATCH`                                                                   | Token was minted for another OAuth client; stop and correct the client/token pairing.                                                                                 |
| `GMAIL_ACCEPTANCE_OAUTH_SCOPE_DRIFT`                                                                         | Missing or additional scope; revoke and repeat exact-scope consent.                                                                                                   |
| `GMAIL_ACCEPTANCE_WRONG_ACCOUNT`                                                                             | Profile differs from the protected expected identity; stop without ingesting.                                                                                         |
| `GMAIL_ACCEPTANCE_CHECKPOINT_ACCOUNT_MISMATCH` / `GMAIL_ACCEPTANCE_CHECKPOINT_INVALID`                       | Checkpoint is malformed or belongs to another account/capability snapshot; preserve it for diagnosis, then use a separately named checkpoint for an authorized reset. |
| `GMAIL_ACCEPTANCE_HISTORY_RESET`                                                                             | Gmail rejected the old history cursor; do not claim continuity. Start a separately reviewed bounded reset/backfill.                                                   |
| `GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN`                                                               | Provider/request behavior exceeded the command's bound; stop and inspect code/provider behavior without raising limits.                                               |
| `GMAIL_ACCEPTANCE_MESSAGE_ID_MISMATCH`                                                                       | Listed/history message identity differs from the fetched resource even if its thread matches; reject the evidence.                                                    |
| `GMAIL_ACCEPTANCE_MESSAGE_THREAD_MISMATCH`                                                                   | List/history reference and fetched message disagree; do not accept the evidence.                                                                                      |
| `GMAIL_ACCEPTANCE_TIMEOUT`                                                                                   | An OAuth, Gmail, or overall fixed deadline elapsed; no retry is attempted and the run must not be accepted.                                                           |
| `GMAIL_ACCEPTANCE_BODY_OR_ATTACHMENT_LEAKAGE`                                                                | Evidence attempted to contain a forbidden content field; treat output as failed and investigate before another live run.                                              |
| `GMAIL_ACCEPTANCE_SEND_FORBIDDEN` / `GMAIL_ACCEPTANCE_UNEXPECTED_API_METHOD`                                 | A caller requested send or code crossed the four-method allowlist; the guard denied the call.                                                                         |

`status: "pass"` proves only this bounded read-only command at that time. It
does not prove a live outbound reply, approval/outbox execution, delivery,
Pub/Sub watch, or production release. No live account acceptance has been run
or claimed by this document.

## Revoke, rotate, and clean up

After evidence collection, revoke the test application's access from the
controlled Google account (or revoke the refresh token through the approved
Google control-plane flow). Rotate/re-consent before a later demo when the
Testing grant or operator policy requires it. Delete the local refresh-token,
client, expected-account, and checkpoint files using the operator's approved
secure cleanup procedure. Do not use this acceptance command for revocation:
its provider authority is intentionally read-only and it rejects mutation
requests.
