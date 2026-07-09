"""One-time: mint a Gmail refresh token via the OAuth consent flow.

Prereq: a Google OAuth "Desktop app" client. Download its JSON as ``client_secret.json``
in the repo root (or pass a path). This opens your browser, you approve read + send
access, and it prints the three values to paste into ``.env``.

    python -m cos.scripts.mint_gmail_token [path/to/client_secret.json]

Scopes: gmail.readonly (ingest inbox + sent) and gmail.send (approved replies).
The refresh token is long-lived; the access token is derived from it at request time.
"""

from __future__ import annotations

import json
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
]


def main(secret_path: str = "client_secret.json") -> None:
    try:
        with open(secret_path) as fh:
            raw = json.load(fh)
    except FileNotFoundError:
        sys.exit(f"{secret_path} not found. Download your OAuth Desktop client JSON there.")

    flow = InstalledAppFlow.from_client_secrets_file(secret_path, SCOPES)
    # Opens a browser; falls back to a console URL if no browser is available.
    creds = flow.run_local_server(port=0, prompt="consent")

    conf = raw.get("installed") or raw.get("web") or {}
    print("\n# ---- paste into .env ----")
    print(f"GMAIL_BASE_URL=https://gmail.googleapis.com")
    print(f"GOOGLE_CLIENT_ID={conf.get('client_id', '')}")
    print(f"GOOGLE_CLIENT_SECRET={conf.get('client_secret', '')}")
    print(f"GOOGLE_REFRESH_TOKEN={creds.refresh_token}")
    print("# --------------------------")
    if not creds.refresh_token:
        print("\n! No refresh token returned. Revoke prior access at "
              "https://myaccount.google.com/permissions and re-run (prompt=consent forces it).")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "client_secret.json")
