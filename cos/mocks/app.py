"""One FastAPI app mounting every provider mock.

Run: ``uvicorn cos.mocks.app:app --port 8900``
Each router uses the provider's real native paths, so the real client SDKs — pointed at
this host — behave as if talking to production.
"""

from __future__ import annotations

from fastapi import FastAPI

from cos.mocks import asana_router, gmail_router, whatsapp_router, x_router
from cos.mocks.store import store

app = FastAPI(title="Chief of Staff — provider mocks")

app.include_router(gmail_router.router, tags=["gmail"])
app.include_router(x_router.router, tags=["x"])
app.include_router(whatsapp_router.router, tags=["whatsapp"])
app.include_router(asana_router.router, tags=["asana"])


@app.get("/")
def index():
    return {
        "service": "chief-of-staff mocks",
        "providers": ["gmail", "x", "whatsapp", "asana"],
        "counts": {
            "gmail": len(store.gmail["messages"]),
            "x_mentions": len(store.x["mentions"]),
            "x_dms": len(store.x["dm_events"]),
            "whatsapp": len(store.whatsapp["messages"]),
            "asana_tasks": len(store.asana["tasks"]),
        },
    }


@app.post("/_reset")
def reset():
    store.reset()
    return {"ok": True}
