"""IMAP/SMTP connector — the "second email provider beyond Gmail" channel (real).

Credential (stored in connector_tokens.refresh_token) is a small JSON blob the
Connections UI builds:  {"password","imap_host","imap_port","smtp_host","smtp_port"}.
Only password + imap_host are required; SMTP host defaults to the IMAP host with
imap→smtp, ports default to 993 (IMAP SSL) / 465 (SMTP SSL). account_handle is the
email address. Works with any standard IMAP provider (Fastmail, Outlook/M365,
Yahoo, iCloud, Gmail-app-password, self-hosted).

Defensive parsing throughout: one malformed message never kills the sync.
"""
from __future__ import annotations

import email
import imaplib
import json
import logging
import smtplib
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.utils import getaddresses, parsedate_to_datetime
from typing import Iterable

from .base import RawMessage

log = logging.getLogger(__name__)

FETCH_LIMIT = 200  # newest N messages per sync (polite; store dedups)


def _decode(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def _addr(pair) -> dict:
    name, addr = pair
    return {"handle": addr, "display_name": _decode(name) or addr}


class ImapConnector:
    channel = "email"

    def __init__(self, account_handle: str, secret: str) -> None:
        cfg = json.loads(secret) if secret.strip().startswith("{") else {"password": secret}
        self.account_handle = account_handle
        self.password = cfg["password"]
        self.imap_host = cfg.get("imap_host") or _guess_host(account_handle)
        self.imap_port = int(cfg.get("imap_port", 993))
        self.smtp_host = cfg.get("smtp_host") or self.imap_host.replace("imap", "smtp")
        # iCloud / Outlook require STARTTLS on 587; Yahoo/Gmail/Fastmail use implicit SSL on 465
        default_smtp_port = 587 if any(h in self.smtp_host for h in ("me.com", "office365", "outlook")) else 465
        self.smtp_port = int(cfg.get("smtp_port", default_smtp_port))

    # -- fetch ----------------------------------------------------------------
    def fetch(self) -> Iterable[RawMessage]:
        conn = imaplib.IMAP4_SSL(self.imap_host, self.imap_port, timeout=30)
        try:
            conn.login(self.account_handle, self.password)
            conn.select("INBOX", readonly=True)
            typ, data = conn.search(None, "ALL")
            if typ != "OK":
                raise RuntimeError(f"IMAP search failed: {typ}")
            uids = data[0].split()[-FETCH_LIMIT:]  # newest N
            for uid in uids:
                try:
                    typ, msgdata = conn.fetch(uid, "(RFC822)")
                    if typ != "OK" or not msgdata or not msgdata[0]:
                        continue
                    raw = msgdata[0][1]
                    yield self._to_raw(uid.decode(), email.message_from_bytes(raw))
                except Exception as e:  # defensive: skip the bad one, keep the sync
                    log.warning("imap: skipping uid %s (%s: %s)", uid, type(e).__name__, e)
        finally:
            try:
                conn.logout()
            except Exception:
                pass

    def _to_raw(self, uid: str, msg: email.message.Message) -> RawMessage:
        from_pairs = getaddresses([msg.get("From", "")])
        sender = _addr(from_pairs[0]) if from_pairs else {"handle": "unknown", "display_name": "unknown"}
        to_pairs = getaddresses(msg.get_all("To", []) or [])
        is_self = sender["handle"].lower() == self.account_handle.lower()
        msg_id = _decode(msg.get("Message-ID")) or f"imap-{uid}"
        # thread by References root / In-Reply-To, else the message's own id
        refs = (msg.get("References") or "").split()
        in_reply = (msg.get("In-Reply-To") or "").strip()
        thread_id = (refs[0] if refs else in_reply) or msg_id
        try:
            sent_at = parsedate_to_datetime(msg.get("Date")) or datetime.now(timezone.utc)
            if sent_at.tzinfo is None:
                sent_at = sent_at.replace(tzinfo=timezone.utc)
        except Exception:
            sent_at = datetime.now(timezone.utc)
        attachments = [
            {"filename": _decode(p.get_filename()), "mime": p.get_content_type()}
            for p in msg.walk() if p.get_filename()
        ]
        return RawMessage(
            channel="email",
            account_handle=self.account_handle,
            external_id=msg_id,
            external_thread_id=thread_id,
            direction="outbound" if is_self else "inbound",
            sender=sender,
            recipients=[_addr(p) for p in to_pairs],
            body_text=_body_text(msg),
            subject=_decode(msg.get("Subject")),
            sent_at=sent_at,
            attachments=attachments,
            raw_ref=f"imap:{self.account_handle}:{uid}",
        )

    # -- send -----------------------------------------------------------------
    def send(self, to: list[dict], body: str, thread_external_id: str | None,
             subject: str | None = None) -> str:
        em = EmailMessage()
        em["To"] = ", ".join(t["handle"] for t in to)
        em["From"] = self.account_handle
        subj = (subject or "").strip()
        if subj and not subj.lower().startswith("re:"):
            subj = f"Re: {subj}"
        em["Subject"] = subj or "Re:"
        if thread_external_id:  # thread the reply
            em["In-Reply-To"] = thread_external_id
            em["References"] = thread_external_id
        em.set_content(body)
        # NOTE: many PaaS hosts (Render, Heroku, …) block outbound SMTP ports (465/587)
        # to prevent spam — a send there hangs, so the timeout turns it into a fast, clear
        # error instead of a stuck request. (Gmail send avoids this: it's an HTTPS API.)
        try:
            if self.smtp_port == 465:  # implicit SSL (Yahoo, Gmail, Fastmail)
                with smtplib.SMTP_SSL(self.smtp_host, self.smtp_port, timeout=20) as s:
                    s.login(self.account_handle, self.password)
                    s.send_message(em)
            else:  # STARTTLS (iCloud 587, Outlook 587)
                with smtplib.SMTP(self.smtp_host, self.smtp_port, timeout=20) as s:
                    s.starttls()
                    s.login(self.account_handle, self.password)
                    s.send_message(em)
        except (OSError, smtplib.SMTPException) as e:
            raise RuntimeError(
                f"SMTP send to {self.smtp_host}:{self.smtp_port} failed ({type(e).__name__}). "
                "If hosted on a PaaS that blocks outbound SMTP (Render/Heroku), IMAP send is "
                "unavailable there — receive/triage still work."
            ) from e
        return em["Message-ID"] or f"imap-sent-{datetime.now(timezone.utc).timestamp()}"


def _guess_host(email_addr: str) -> str:
    domain = email_addr.split("@")[-1].lower()
    known = {
        "gmail.com": "imap.gmail.com",
        "outlook.com": "outlook.office365.com",
        "hotmail.com": "outlook.office365.com",
        "office365.com": "outlook.office365.com",
        "yahoo.com": "imap.mail.yahoo.com",
        "icloud.com": "imap.mail.me.com",
        "fastmail.com": "imap.fastmail.com",
    }
    return known.get(domain, f"imap.{domain}")


def _body_text(msg: email.message.Message) -> str:
    """Prefer text/plain; fall back to stripped text/html; defensive decode."""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and not part.get_filename():
                try:
                    return part.get_content()[:8000]
                except Exception:
                    payload = part.get_payload(decode=True) or b""
                    return payload.decode("utf-8", "replace")[:8000]
        return ""
    try:
        return msg.get_content()[:8000]
    except Exception:
        payload = msg.get_payload(decode=True) or b""
        return payload.decode("utf-8", "replace")[:8000]
