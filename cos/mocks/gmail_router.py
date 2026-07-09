"""Mock of the Gmail API v1 endpoints the google-api-python-client calls."""

from __future__ import annotations

import base64
import email
import time

from fastapi import APIRouter, Request

from cos.mocks.store import store

router = APIRouter()


@router.get("/gmail/v1/users/{user_id}/messages")
def list_messages(user_id: str, q: str | None = None, labelIds: str | None = None,
                  maxResults: int = 100):
    msgs = store.gmail["messages"]
    if labelIds:
        wanted = set(labelIds.split(","))
        msgs = [m for m in msgs if wanted & set(m.get("labelIds", []))]
    refs = [{"id": m["id"], "threadId": m["threadId"]} for m in msgs[:maxResults]]
    return {"messages": refs, "resultSizeEstimate": len(refs)}


@router.get("/gmail/v1/users/{user_id}/messages/{message_id}")
def get_message(user_id: str, message_id: str, format: str = "full"):
    for m in store.gmail["messages"]:
        if m["id"] == message_id:
            return m
    return {"error": {"code": 404, "message": "Not Found"}}


@router.post("/gmail/v1/users/{user_id}/messages/send")
async def send_message(user_id: str, request: Request):
    body = await request.json()
    raw = body.get("raw", "")
    try:
        decoded = base64.urlsafe_b64decode(raw.encode()).decode(errors="replace")
        parsed = email.message_from_string(decoded)
        thread_id = body.get("threadId", "gmailthr-sent")
        text = parsed.get_payload()
        subject = parsed.get("Subject", "")
    except Exception:
        thread_id, text, subject = body.get("threadId", "gmailthr-sent"), raw, ""
    mid = store.next_id("gmailmsg-sent-")
    sent = {
        "id": mid, "threadId": thread_id, "labelIds": ["SENT"],
        "internalDate": str(int(time.time() * 1000)), "snippet": text[:80],
        "payload": {"mimeType": "text/plain",
                    "headers": [{"name": "Subject", "value": subject}],
                    "body": {"data": base64.urlsafe_b64encode(text.encode()).decode()}},
    }
    store.gmail["messages"].append(sent)
    return {"id": mid, "threadId": thread_id, "labelIds": ["SENT"]}
