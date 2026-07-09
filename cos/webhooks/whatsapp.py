"""WhatsApp Cloud API webhook receiver (real-mode inbound).

Meta pushes inbound messages here instead of exposing a pollable list. Two routes,
matching the Cloud API contract:

* ``GET  /webhooks/whatsapp`` — the one-time verification handshake. Meta sends
  ``hub.mode=subscribe`` + ``hub.verify_token``; we echo ``hub.challenge`` when the token
  matches ``WHATSAPP_VERIFY_TOKEN``.
* ``POST /webhooks/whatsapp`` — message delivery. We verify the ``X-Hub-Signature-256``
  HMAC against ``WHATSAPP_APP_SECRET``, flatten the nested payload, and buffer the raw
  ``messages``/``contacts`` for the connector to drain.

Run standalone (``uvicorn cos.webhooks.whatsapp:app``) behind a public HTTPS URL, or mount
``router`` into an existing app.
"""

from __future__ import annotations

import hashlib
import hmac

from fastapi import APIRouter, FastAPI, Header, HTTPException, Request, Response

from cos.config import get_settings
from cos.connectors import whatsapp_inbox

router = APIRouter()


@router.get("/webhooks/whatsapp")
def verify(request: Request) -> Response:
    q = request.query_params
    if (q.get("hub.mode") == "subscribe"
            and q.get("hub.verify_token") == get_settings().whatsapp_verify_token):
        return Response(content=q.get("hub.challenge", ""), media_type="text/plain")
    raise HTTPException(status_code=403, detail="verification failed")


def _valid_signature(app_secret: str, raw: bytes, header: str | None) -> bool:
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(app_secret.encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header[len("sha256="):])


@router.post("/webhooks/whatsapp")
async def receive(
    request: Request,
    x_hub_signature_256: str | None = Header(default=None),
) -> dict:
    s = get_settings()
    raw = await request.body()
    # Signature check is enforced whenever an app secret is configured.
    if s.whatsapp_app_secret and not _valid_signature(
            s.whatsapp_app_secret, raw, x_hub_signature_256):
        raise HTTPException(status_code=401, detail="invalid signature")

    payload = await request.json()
    messages: list[dict] = []
    contacts: list[dict] = []
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            messages.extend(value.get("messages", []))
            contacts.extend(value.get("contacts", []))
    if messages or contacts:
        whatsapp_inbox.append(messages, contacts)
    return {"received": len(messages)}


app = FastAPI(title="WhatsApp webhook receiver")
app.include_router(router)
