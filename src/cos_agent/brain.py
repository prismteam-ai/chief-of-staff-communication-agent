"""Brain: per inbound message → recommendation + style-matched draft.

Context assembly is dynamic injection only (CLAUDE.md: no hardcoded example
names in prompts — an ancestor bot greeted real users as "Sarah").
Every claim the brain makes cites retrieved context; low confidence routes
to needs_context instead of a made-up answer.
"""
from __future__ import annotations

import json

from openai import AzureOpenAI

from .config import settings
from .db import sb
from .rag import search

RECOMMEND_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"enum": ["reply", "create_task", "link_task", "delegate", "archive", "needs_context"]},
        "rationale": {"type": "string"},
        "needs_context": {"type": "boolean"},
        "context_question": {"type": ["string", "null"]},
        "draft_body": {"type": ["string", "null"]},
        "style_notes": {"type": ["string", "null"]},
        "topic_key": {"type": ["string", "null"]},
        "task_title": {"type": ["string", "null"]},
        "task_detail": {"type": ["string", "null"]},
    },
    "required": [
        "action", "rationale", "needs_context", "context_question",
        "draft_body", "style_notes", "topic_key", "task_title", "task_detail",
    ],
    "additionalProperties": False,
}


def _chat_client() -> AzureOpenAI:
    s = settings()
    return AzureOpenAI(
        api_key=s.azure_chat_key, azure_endpoint=s.azure_chat_endpoint, api_version="2024-06-01"
    )


def _style_corpus(limit: int = 8) -> list[str]:
    """The executive's actual outbound messages = style few-shot, injected dynamically."""
    res = (
        sb().table("messages").select("channel, body_text")
        .eq("direction", "outbound").order("sent_at", desc=True).limit(limit).execute()
    )
    return [f"[{r['channel']}] {r['body_text']}" for r in res.data]


def _thread_history(thread_id: str, limit: int = 10) -> list[str]:
    res = (
        sb().table("messages").select("direction, sender, body_text, sent_at")
        .eq("thread_id", thread_id).order("sent_at", desc=True).limit(limit).execute()
    )
    return [
        f"{r['sent_at']} {r['sender'].get('display_name') or r['sender'].get('handle')} ({r['direction']}): {r['body_text']}"
        for r in reversed(res.data)
    ]


def process_message(message_id: str) -> dict:
    """Recommend + draft for one inbound message. Idempotent per message."""
    existing = sb().table("recommendations").select("id").eq("message_id", message_id).execute()
    if existing.data:
        return {"message_id": message_id, "skipped": "already processed"}

    msg = sb().table("messages").select("*").eq("id", message_id).single().execute().data
    history = _thread_history(msg["thread_id"])
    style = _style_corpus()
    known_topics = sorted(
        {r["topic_key"] for r in sb().table("topic_links").select("topic_key").execute().data}
    )
    related = search(msg["body_text"], match_count=5)
    related_block = "\n".join(
        f"- ({r['source_type']}, sim {r['similarity']:.2f}) {r['content'][:220]}" for r in related
    )

    system = (
        "You are a chief-of-staff communication agent for an executive. "
        "For the incoming message, decide the next action and, when action is 'reply', "
        "draft the response in the executive's voice using the style samples. "
        "Ground every factual claim in the thread history or retrieved context; "
        "if you cannot answer confidently, use action 'needs_context' and ask one precise question. "
        "topic_key: a short kebab-case slug naming the person/project/decision this message belongs to, "
        "consistent across channels. If the message belongs to one of known_topic_keys, REUSE that exact key "
        "instead of inventing a variant. "
        "If the message requires tracked follow-up work (a deliverable, a deadline, an owed action), "
        "set task_title (imperative, <=70 chars) and task_detail (what, who, by when) — even when the "
        "action is 'reply', a reply can still need a task. Otherwise leave them null."
    )
    user = json.dumps(
        {
            "incoming_message": {
                "channel": msg["channel"],
                "from": msg["sender"],
                "body": msg["body_text"],
                "sent_at": msg["sent_at"],
            },
            "thread_history": history,
            "retrieved_context": related_block,
            "known_topic_keys": known_topics,
            "executive_style_samples": style,
        },
        ensure_ascii=False,
    )

    s = settings()
    res = _chat_client().chat.completions.create(
        model=s.chat_deployment,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        response_format={
            "type": "json_schema",
            "json_schema": {"name": "recommendation", "schema": RECOMMEND_SCHEMA, "strict": True},
        },
    )
    out = json.loads(res.choices[0].message.content)

    sb().table("recommendations").insert(
        {
            "message_id": message_id,
            "action": out["action"],
            "rationale": out["rationale"],
            "needs_context": out["needs_context"],
            "context_question": out.get("context_question"),
            "model": s.chat_deployment,
        }
    ).execute()

    if out["action"] == "reply" and out.get("draft_body"):
        sb().table("drafts").insert(
            {
                "message_id": message_id,
                "body": out["draft_body"],
                "style_notes": out.get("style_notes"),
                "model": s.chat_deployment,
            }
        ).execute()

    if out.get("task_title"):
        from .asana import task_from_message  # local import: avoids cycle at module load

        try:
            task = task_from_message(message_id, out["task_title"], out.get("task_detail") or out["rationale"])
            out["asana_task_url"] = task.get("permalink_url")
        except Exception as e:  # task failure never blocks the reply path
            out["asana_error"] = f"{type(e).__name__}: {e}"

    if out.get("topic_key"):
        sb().table("topic_links").upsert(
            {
                "topic_key": out["topic_key"],
                "message_id": message_id,
                "reason": out["rationale"][:200],
                "confidence": 0.7,
            },
            on_conflict="topic_key,message_id",
        ).execute()

    return {"message_id": message_id, **out}


def redraft_with_context(message_id: str, user_context: str) -> dict:
    """Answer a needs-context question: re-draft one message using the executive's
    supplied context as authoritative. Flips the recommendation to a reply + draft.
    This is the closing half of criterion 21 (prompt for context → act on it)."""
    msg = sb().table("messages").select("*").eq("id", message_id).single().execute().data
    history = _thread_history(msg["thread_id"])
    style = _style_corpus()
    related = search(msg["body_text"], match_count=5)
    related_block = "\n".join(
        f"- ({r['source_type']}, sim {r['similarity']:.2f}) {r['content'][:220]}" for r in related
    )

    system = (
        "You are a chief-of-staff communication agent. The executive has just supplied "
        "the missing context you asked for — treat it as authoritative and now draft the "
        "reply in their voice (action MUST be 'reply'). Ground the reply in that context "
        "plus the thread history; do not contradict it. Keep the style concise and matched "
        "to the samples. task_title/task_detail only if real follow-up work is implied."
    )
    user = json.dumps(
        {
            "incoming_message": {"channel": msg["channel"], "from": msg["sender"],
                                 "body": msg["body_text"], "sent_at": msg["sent_at"]},
            "executive_provided_context": user_context,
            "thread_history": history,
            "retrieved_context": related_block,
            "executive_style_samples": style,
        },
        ensure_ascii=False,
    )
    s = settings()
    res = _chat_client().chat.completions.create(
        model=s.chat_deployment,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        response_format={
            "type": "json_schema",
            "json_schema": {"name": "recommendation", "schema": RECOMMEND_SCHEMA, "strict": True},
        },
    )
    out = json.loads(res.choices[0].message.content)

    # record the supplied context on the message's thread as org knowledge for future RAG
    from .rag import index_knowledge

    try:
        index_knowledge("preference", f"context-{message_id}",
                        f"Executive-provided context re: {msg['body_text'][:80]} — {user_context}")
    except Exception:
        pass

    rec = sb().table("recommendations").select("id").eq("message_id", message_id).execute().data
    fields = {"action": "reply", "needs_context": False, "context_question": None,
              "rationale": out["rationale"], "model": s.chat_deployment}
    if rec:
        sb().table("recommendations").update(fields).eq("message_id", message_id).execute()
    else:
        sb().table("recommendations").insert({"message_id": message_id, **fields}).execute()

    draft = None
    if out.get("draft_body"):
        draft = sb().table("drafts").insert({
            "message_id": message_id, "body": out["draft_body"],
            "style_notes": out.get("style_notes"), "model": s.chat_deployment,
        }).execute().data[0]
    return {"message_id": message_id, "draft": draft, **out}


def process_pending(limit: int = 50) -> list[dict]:
    """Process all unhandled inbound messages (defensive: one failure never kills the batch)."""
    pending = (
        sb().table("messages").select("id")
        .eq("direction", "inbound").eq("answered_status", "pending")
        .order("sent_at").limit(limit).execute()
    ).data
    results = []
    for row in pending:
        try:
            results.append(process_message(row["id"]))
        except Exception as e:
            results.append({"message_id": row["id"], "error": f"{type(e).__name__}: {e}"})
    return results
