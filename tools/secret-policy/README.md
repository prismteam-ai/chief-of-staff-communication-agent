# Repository secret policy

This dependency-free Node 22 toolchain protects the repository before any
account-owned configuration file is opened.

## Commands

Run the generated positive/negative fixture suite. Fixtures exist only under
the operating system temporary directory and are removed after the run:

```text
node tools/secret-policy/self-test.mjs
```

Scan the Git worktree's tracked files and unignored untracked files:

```text
node tools/secret-policy/scan.mjs --repo . --format text
```

Exit codes are deterministic: `0` is clean, `1` means redacted findings, and
`2` means a scanner, policy, or repository-identity error. Both `1` and `2`
block credential ingress. Output contains rule IDs, repository-relative paths,
and line numbers only; it never contains matched values or match hashes.

The scanner deliberately uses Git's tracked/unignored inventory. Ignored local
credential files are not opened. A prohibited file that is tracked despite an
ignore rule is still enumerated and rejected by path without reading its
contents.

Reported paths are normalized and safe for text or JSON output. Common secret
patterns embedded in a filename are replaced with `[REDACTED]`, control
characters become `[CONTROL]`, and secret-bearing filenames are rejected
without opening their contents. No raw match or equality-comparable hash is
emitted.

After a clean scan and a separately approved credential-read gate, import only
explicitly named variables from one approved external environment file:

```text
node tools/secret-policy/ingest-env.mjs --repo . --source <approved-account-file> --allow GOOGLE_CLIENT_ID --allow GOOGLE_CLIENT_SECRET
```

The ingress tool verifies the repository first, requires an external regular
non-symlink source, requires the destination to be ignored and untracked,
refuses to overwrite an existing destination, requests mode `0600`, and reports
variable names and counts without values. It does not expand variables or
execute the source file. On Windows, use an ACL-restricted working directory and
verify the inherited ACL before real ingress because POSIX mode bits do not
fully describe NTFS permissions. Never shell-source an account file.

## Policy boundaries

- `.env.example` is the only allowed environment template and remains empty.
- Tracked or unignored environment files, access-key CSVs, credential/token
  exports, private-key files, and credential-bearing dotfiles fail the scan.
- Any tracked entry below repository-root `.config/` fails by path before a
  content read, even when `.gitignore` would normally hide it.
- High-confidence decorated exports such as `credential-export.json`,
  `github-token.txt`, auth exports, client-secret exports, and service-account
  exports are denied. Generic source names such as `design-tokens.json` remain
  visible to avoid hiding legitimate code or design artifacts.
- Content rules cover common AWS, GitHub, OpenAI, Google, Slack, JWT, PEM
  private-key, pre-signed URL, and high-confidence named-secret forms.
- Assignment rules are line-bound. AWS secret-key and high-confidence named-
  secret rules accept only spaces or tabs around `:`/`=`; their Node boundary
  prefix also excludes CR/LF. The pre-signed-signature rule uses the literal
  query-string `=` form with a hex-only value and cannot cross a line.
- Windows and Linux repository-relative paths normalize to one forward-slash
  form; absolute paths and traversal fail closed.
- Oversized files, symlinks, identity drift, unreadable files, invalid policy,
  and Git inventory failures fail closed rather than being skipped.
- The self-test copies the actual repository `.gitignore` into a temporary Git
  repository and proves both the credential exclusions and the legitimate
  `design-tokens.json` boundary.
- The self-test also uses separate OS-temp Git repositories to prove every
  assignment rule rejects a value on a later LF/CRLF-delimited line, detects a
  representative same-line synthetic assignment, and emits no matched value.
