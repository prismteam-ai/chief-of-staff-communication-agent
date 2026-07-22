# Credential ingress

Status: implemented safety boundary; no account-owned credential file was read
while establishing this baseline.

## Invariant

Repository secret policy must be clean before an operator opens an account
file. Credential values never enter Git, command arguments, logs, scanner
output, change receipts, screenshots, or evidence artifacts.

Static AWS administrator credentials and access-key CSV exports are prohibited.
Deployed workloads use scoped IAM roles; provider client secrets belong in AWS
Secrets Manager and provider refresh tokens use the approved KMS envelope
store. Local ignored environment files are a development-only ingress bridge,
not a runtime secret store.

## Approved sequence

1. Confirm the intended repository branch and base identity.
2. Run `node tools/secret-policy/self-test.mjs` with Node 22.
3. Run `node tools/secret-policy/scan.mjs --repo . --format text` and require
   exit code `0`. Exit `1` (findings) and exit `2` (scanner/identity error) both
   block ingress.
4. Obtain the separate approval that names the exact external source file,
   provider, operation, and minimum variable names. This baseline does not grant
   that approval.
5. Use the non-executing loader with an explicit allowlist, for example:

   ```text
   node tools/secret-policy/ingest-env.mjs --repo . --source <approved-account-file> --destination google.env --allow GOOGLE_CLIENT_ID --allow GOOGLE_CLIENT_SECRET
   ```

6. Confirm the result reports variable names and counts only with
   `values_emitted=false`. Never paste or echo the destination.
7. Load the ignored destination through the application's dotenv-compatible
   configuration boundary. Never shell-source the account file or destination.
8. Delete the local destination when the approved operation ends and rotate or
   revoke credentials according to the provider runbook.

The loader scans first, accepts only an external regular non-symlink file,
requires an ignored and untracked repository-root destination, refuses an
existing destination, selects only allowlisted names, does no substitution or
execution, and requests mode `0600`. On Windows, the operator must additionally
verify that the working directory's inherited NTFS ACL is restricted to the
intended principal before real ingress; POSIX mode bits alone are not an ACL
proof. A separate destination per provider keeps ingress scope explicit.

## Repository policy

The committed `.env.example` is a names-only contract with empty values.
`.gitignore`, `.gitleaks.toml`, and `tools/secret-policy/policy.json` jointly
cover environment files, cloud credential stores, access-key CSVs,
credential/token exports, private-key material, and common token formats.
Repository-root `.config/**` is always prohibited when tracked, and is rejected
by path before content is opened. Decorated high-confidence names—including
`credential-export.json`, `github-token.txt`, auth exports, client-secret
exports, and service-account exports—are denied across JSON, YAML, CSV, and
text forms. The policy intentionally does not hide generic source artifacts
such as `design-tokens.json`.

The dependency-free scanner inventories exactly Git-tracked and unignored
untracked files. A prohibited tracked/unignored path is reported without
opening it. Ignored local credentials are not scanned or printed. Symlinks,
oversized files, unreadable files, Git failures, root mismatch, malformed
policy, and path traversal fail closed.

Assignment-oriented content rules are explicitly line-bound: only spaces and
tabs are allowed around `:` or `=`, and the Node scanner's boundary prefix
cannot consume CR or LF. The pre-signed-signature query rule is inherently
line-bound by its literal `=` and hex-only value. Automated OS-temp fixtures
prove that later-line values are ignored while representative same-line
synthetic assignments remain detectable; `.env.example` is not allowlisted
from either scanner.

## Output and incident handling

Findings contain only a rule ID, normalized repository-relative path, and line
number when content was scanned. They contain no matched value, excerpt,
fingerprint, or equality-comparable secret hash.
If a common secret appears in a filename, the scanner rejects that path without
opening the file and replaces the value with `[REDACTED]`; control characters
in reportable paths become `[CONTROL]`.

If a real credential is suspected in repository history, stop using it,
disable or revoke it at the provider, rotate it, preserve redacted incident
metadata, and coordinate history remediation separately. Adding an ignore rule
does not remove an already tracked or historical credential.
