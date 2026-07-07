"""RAG layer: embed store content into rag_documents (pgvector), search via rpc."""
from __future__ import annotations

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


def index_messages(batch_size: int = 64) -> dict:
    """Embed messages not yet in rag_documents. Idempotent via unique(source_type, source_id)."""
    msgs = sb().table("messages").select("id, channel, direction, sender, body_text, sent_at").execute().data
    have = {
        r["source_id"]
        for r in sb().table("rag_documents").select("source_id").eq("source_type", "message").execute().data
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
                "source_type": "message",
                "source_id": m["id"],
                "content": t,
                "embedding": v,
                "metadata": {"channel": m["channel"], "direction": m["direction"], "sent_at": m["sent_at"]},
            }
            for m, t, v in zip(chunk, texts, vectors)
        ]
        sb().table("rag_documents").upsert(rows, on_conflict="source_type,source_id").execute()
        indexed += len(rows)
    return {"indexed": indexed, "already_indexed": len(msgs) - len(todo)}


def index_knowledge(source_type: str, source_id: str, content: str, metadata: dict | None = None) -> None:
    """Index a preference / org-knowledge / asana document."""
    vec = embed([content])[0]
    sb().table("rag_documents").upsert(
        {
            "source_type": source_type,
            "source_id": source_id,
            "content": content,
            "embedding": vec,
            "metadata": metadata or {},
        },
        on_conflict="source_type,source_id",
    ).execute()


def search(query: str, match_count: int = 6) -> list[dict]:
    vec = embed([query])[0]
    res = sb().rpc("rag_search", {"query_embedding": vec, "match_count": match_count}).execute()
    return res.data
