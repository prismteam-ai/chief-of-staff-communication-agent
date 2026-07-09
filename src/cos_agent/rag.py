"""RAG layer: embed store content into rag_documents (pgvector), search via rpc."""
from __future__ import annotations

import uuid

from openai import AzureOpenAI

from .config import settings
from .db import sb


def _embed_client() -> AzureOpenAI:
    s = settings()
    return AzureOpenAI(
        api_key=s.azure_embed_key,
        azure_endpoint=s.azure_embed_endpoint,
        api_version="2024-06-01",
    )


def embed(texts: list[str]) -> list[list[float]]:
    res = _embed_client().embeddings.create(model=settings().embed_deployment, input=texts)
    return [d.embedding for d in res.data]


def index_messages(owner: str, batch_size: int = 64) -> dict:
    """Embed this owner's messages not yet in rag_documents. Owner-scoped both ways
    (only their messages, only their existing docs). Idempotent via the per-owner
    unique(owner_id, source_type, source_id)."""
    msgs = (
        sb().table("messages").select("id, channel, direction, sender, body_text, sent_at")
        .eq("owner_id", owner).execute().data
    )
    have = {
        r["source_id"]
        for r in sb().table("rag_documents").select("source_id")
        .eq("owner_id", owner).eq("source_type", "message").execute().data
    }
    todo = [m for m in msgs if m["id"] not in have]
    indexed = 0
    for i in range(0, len(todo), batch_size):
        chunk = todo[i : i + batch_size]
        texts = [
            f"[{m['channel']}/{m['direction']}] {m['sender'].get('display_name') or m['sender'].get('handle')}: {m['body_text']}"
            for m in chunk
        ]
        vectors = embed(texts)
        rows = [
            {
                "owner_id": owner,
                "source_type": "message",
                "source_id": m["id"],
                "content": t,
                "embedding": v,
                "metadata": {"channel": m["channel"], "direction": m["direction"], "sent_at": m["sent_at"]},
            }
            for m, t, v in zip(chunk, texts, vectors)
        ]
        sb().table("rag_documents").upsert(rows, on_conflict="owner_id,source_type,source_id").execute()
        indexed += len(rows)
    return {"indexed": indexed, "already_indexed": len(msgs) - len(todo)}


def index_knowledge(owner: str, source_type: str, source_id: str, content: str,
                    metadata: dict | None = None) -> None:
    """Index a preference / org-knowledge / asana document, owned by `owner`."""
    vec = embed([content])[0]
    sb().table("rag_documents").upsert(
        {
            "owner_id": owner,
            "source_type": source_type,
            "source_id": source_id,
            "content": content,
            "embedding": vec,
            "metadata": metadata or {},
        },
        on_conflict="owner_id,source_type,source_id",
    ).execute()


def search(query: str, owner: str, match_count: int = 6) -> list[dict]:
    """Vector search scoped to one tenant — p_owner prevents cross-tenant leakage."""
    vec = embed([query])[0]
    res = sb().rpc(
        "rag_search", {"query_embedding": vec, "match_count": match_count, "p_owner": owner}
    ).execute()
    return res.data


# --- Knowledge layer (user preferences + org knowledge) ----------------------
# The RAG AC's 3rd/4th inputs: things the user TEACHES the agent. Stored as
# rag_documents with source_type preference|org and a "kb:" source_id (to tell them
# apart from message/asana/derived docs). They flow into drafting two ways: preferences
# are injected into every draft (always-on rules); org facts surface via semantic search.
def get_preferences(owner: str, limit: int = 30) -> list[str]:
    rows = (
        sb().table("rag_documents").select("content")
        .eq("owner_id", owner).eq("source_type", "preference").like("source_id", "kb:%")
        .order("created_at").limit(limit).execute().data
    )
    return [r["content"] for r in rows]


def get_org_knowledge(owner: str, limit: int = 30) -> list[str]:
    """User-authored organizational facts (kb:org). These are a small curated set the exec
    typed, so they're injected into every draft as always-on context — unlike message history
    (which is retrieved by similarity), one org fact would otherwise never win top-k retrieval."""
    rows = (
        sb().table("rag_documents").select("content")
        .eq("owner_id", owner).eq("source_type", "org").like("source_id", "kb:%")
        .order("created_at").limit(limit).execute().data
    )
    return [r["content"] for r in rows]


def list_knowledge(owner: str) -> list[dict]:
    rows = (
        sb().table("rag_documents").select("source_id, source_type, content, created_at")
        .eq("owner_id", owner).like("source_id", "kb:%").order("created_at").execute().data
    )
    return [{"id": r["source_id"], "kind": r["source_type"], "text": r["content"],
             "created_at": r["created_at"]} for r in rows]


def add_knowledge_item(owner: str, kind: str, text: str) -> dict:
    sid = f"kb:{kind}:{uuid.uuid4().hex[:12]}"
    index_knowledge(owner, kind, sid, text, {"kind": kind, "user_authored": True})
    return {"id": sid, "kind": kind, "text": text}


def update_knowledge_item(owner: str, source_id: str, kind: str, text: str) -> dict:
    # kind may have changed (→ different source_type); delete the old row, then re-index
    sb().table("rag_documents").delete().eq("owner_id", owner).eq("source_id", source_id).execute()
    index_knowledge(owner, kind, source_id, text, {"kind": kind, "user_authored": True})
    return {"id": source_id, "kind": kind, "text": text}


def delete_knowledge_item(owner: str, source_id: str) -> None:
    sb().table("rag_documents").delete().eq("owner_id", owner).eq("source_id", source_id).like("source_id", "kb:%").execute()
