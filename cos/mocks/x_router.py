"""Mock of the X (Twitter) API v2 endpoints tweepy calls."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request

from cos.mocks.store import store

router = APIRouter()


def _users_include(ids: set[str]) -> list[dict]:
    return [u for u in store.x["users"] if u["id"] in ids]


@router.get("/2/users/{user_id}/mentions")
def mentions(user_id: str):
    data = store.x["mentions"]
    author_ids = {m["author_id"] for m in data}
    return {
        "data": data,
        "includes": {"users": _users_include(author_ids)},
        "meta": {"result_count": len(data)},
    }


@router.get("/2/dm_events")
def dm_events(dm_event_fields: str | None = None, expansions: str | None = None):
    data = store.x["dm_events"]
    sender_ids = {d["sender_id"] for d in data}
    return {
        "data": data,
        "includes": {"users": _users_include(sender_ids)},
        "meta": {"result_count": len(data)},
    }


@router.post("/2/tweets")
async def create_tweet(request: Request):
    body = await request.json()
    tid = store.next_id("99")
    tweet = {
        "id": tid, "text": body.get("text", ""),
        "author_id": "1000000000000000001",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }
    reply = body.get("reply") or {}
    if reply.get("in_reply_to_tweet_id"):
        tweet["conversation_id"] = reply["in_reply_to_tweet_id"]
    store.x["sent"].append(tweet)
    return {"data": {"id": tid, "text": tweet["text"]}}
