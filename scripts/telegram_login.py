"""Produce a Telethon session for the Telegram (personal-account) connector.

Run LOCALLY (needs interactive phone-code entry — can't be done on the server):

    uv run python scripts/telegram_login.py

It asks for your api_id + api_hash (from https://my.telegram.org → API development
tools) and your phone; Telegram texts you a login code; on success it prints a single
JSON blob. Paste that blob into the app's Connections → Telegram form (one field).
The blob contains a StringSession — treat it like a password (full account access).
"""
from __future__ import annotations

import json

from telethon.sync import TelegramClient
from telethon.sessions import StringSession


def main() -> None:
    api_id = int(input("api_id (number, from my.telegram.org): ").strip())
    api_hash = input("api_hash (32-char hex): ").strip()

    # the sync context manager runs .start() → prompts for phone + the code Telegram sends
    with TelegramClient(StringSession(), api_id, api_hash) as client:
        me = client.get_me()
        session = client.session.save()
        handle = ("@" + me.username) if getattr(me, "username", None) else str(me.id)

    blob = json.dumps({"api_id": api_id, "api_hash": api_hash, "session": session})
    print("\n================ paste this into Connections → Telegram ================\n")
    print(blob)
    print(f"\n(logged in as {handle} — keep the blob secret; it is full account access)")


if __name__ == "__main__":
    main()
