# LinkedIn connector and archive import

## Capability truth

The LinkedIn communication connector is `blocked_external_access`. This release
has no proof of approved LinkedIn Communication API entitlement, so live inbox
read, history, threads, attachments, feedback, synchronization, and send remain
typed as `unknown` and exposed as unavailable. The connector declares no OAuth,
poll, webhook, fetch, send, reconciliation, or mutation method. Connection
validation returns an account-bound failed health fact without contacting
LinkedIn.

Archive import is a separate, read-only capability. Importing an archive does
not change the connector's mode and does not prove live LinkedIn coverage. The
implementation never scrapes LinkedIn, automates its UI, opens a provider
session, fetches an attachment URL, sends a message, or adds a mutation route.

## Accepted archive source

The importer accepts only one of these explicit provenance classes:

- a user-provided LinkedIn export, affirmed as `user_export`; or
- a provider-column-shaped synthetic fixture carrying the
  `VISIBLE_SYNTHETIC_LINKEDIN_EXPORT_V1` provenance marker and visibly
  `[SYNTHETIC]` row content.

Exactly one `messages.csv` is required. Its byte-level CSV shape uses these
LinkedIn export columns in this exact order:

```text
CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,DATE,SUBJECT,CONTENT,FOLDER,ATTACHMENTS
```

The source is consumed as bounded byte chunks. The importer validates declared
sizes, limits entry/archive/CSV/record/row/attachment counts, hashes every
entry, and never writes archive paths to disk. Absolute paths, drive paths,
backslashes, encoded/confusable separators, empty/dot/traversal segments,
case-insensitive duplicate paths, and unsafe attachment paths fail closed.

## Normalization and replay

Normalization preserves source provenance, timestamps, participants,
conversations, messages, and attachment references. Local attachment entries
are hashed and size-bound when present. HTTP(S) attachment references remain
metadata only and are never fetched.

Stable IDs are deterministic tenant/account-scoped SHA-256 identifiers.
Replaying the same bytes yields the same archive digest and entity IDs.
Duplicate rows converge to one message; malformed rows produce content-free
issue codes and do not expose the rejected cell value. IDs for the same archive
under another tenant or connector account differ.

Every cell is checked for spreadsheet formula prefixes (`=`, `+`, `-`, `@`,
including leading whitespace) before normalization. Formula-shaped cells fail
the archive import rather than being retained for later CSV export.

## RAG admission

Archive import never indexes into RAG. Every result returns
`admittedToRag=false` plus an admission decision:

- up to 6,000 messages: explicit authorization-scoped admission review is
  still required;
- above 6,000 messages: a separately bounded preselection/projection or
  OpenSearch promotion is required;
- 8,000 is the promotion-evaluation threshold and 10,000 is the bounded
  profile hard-stop threshold from the Chief retrieval plan.

Before any promotion, rerun size, decoded-memory, latency, concurrency,
freshness, retrieval-quality, citation, and tenant-isolation gates. A large
archive cannot silently enter the bounded retrieval profile.

## Verification

From the repository root with Node `22.18.0` first on `PATH`:

```powershell
pnpm --filter @chief/connector-linkedin test
pnpm --filter @chief/connector-linkedin lint
pnpm --filter @chief/connector-linkedin typecheck
pnpm --filter @chief/connector-linkedin build
```

The tests run networklessly with byte-shaped synthetic CSV and attachment
fixtures. They cover the frozen connector contract runner, capability/method
parity, blocked health, stable replay, deduplication, tenant/account isolation,
malformed rows, attachment provenance, CSV formula rejection, archive path
attacks, streaming bounds, and large-archive admission reporting.
