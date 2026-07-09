"""Mock of the WhatsApp (Meta Cloud API) endpoints.

Real inbound WhatsApp arrives via webhooks, not a pollable list — so the GET here is a
mock-only convenience for development. The POST /messages send endpoint matches the real
Cloud API shape exactly, so the connector's send path is production-faithful.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Request

from cos.mocks.store import store

router = APIRouter()


@router.get("/{version}/{phone_id}/messages")
def list_inbound(version: str, phone_id: str):
    # mock-only pull endpoint (real API would deliver these via webhook)
    return {
        "messaging_product": "whatsapp",
        "messages": store.whatsapp["messages"],
        "contacts": store.whatsapp["contacts"],
    }


@router.post("/{version}/{phone_id}/messages")
async def send_message(version: str, phone_id: str, request: Request):
    body = await request.json()
    wamid = store.next_id("wamid.sent.")
    store.whatsapp["sent"].append({
        "id": wamid, "to": body.get("to"), "timestamp": str(int(time.time())),
        "type": "text", "text": body.get("text", {}),
    })
    return {
        "messaging_product": "whatsapp",
        "contacts": [{"input": body.get("to"), "wa_id": body.get("to")}],
        "messages": [{"id": wamid}],
    }
