"""A role agent as an A2A HTTP service.

Serves its agent card at ``/.well-known/agent-card.json`` and handles JSON-RPC
``message/send`` by running the role's LLM (persona from the role registry) on the delegated
task and returning a completed A2A Task.
"""

from __future__ import annotations

import uuid

from fastapi import FastAPI, Request

from cos.agents.a2a.cards import card_for
from cos.agents.a2a.protocol import (A2AMessage, A2ATask, JsonRpcResponse, TaskStatus,
                                     TextPart)
from cos.agents.roles import ROLES


def _handle(role_name: str, task_text: str) -> str:
    from cos.agents.llm import chat
    role = ROLES[role_name]
    prompt = (f"You are {role.persona}\n\n"
              f"A task has been delegated to you by the Chief of Staff:\n{task_text}\n\n"
              "Respond in 1-2 sentences with concretely how you will handle it "
              "(an ETA, an acknowledgement, or the next step). Be specific and brief.")
    return chat().invoke(prompt).content


def build_agent_app(role_name: str, public_url: str = "") -> FastAPI:
    app = FastAPI(title=f"A2A agent: {role_name}")
    url = public_url or f"http://127.0.0.1:0/{role_name}"

    @app.get("/.well-known/agent-card.json")
    def agent_card():
        return card_for(role_name, url).model_dump()

    @app.post("/")
    async def rpc(request: Request):
        body = await request.json()
        rid = body.get("id", 1)
        if body.get("method") != "message/send":
            return JsonRpcResponse(id=rid, error={"code": -32601,
                                                  "message": "method not found"}).model_dump()
        msg = A2AMessage(**body["params"]["message"])
        reply = _handle(role_name, msg.text)
        task = A2ATask(id=uuid.uuid4().hex, status=TaskStatus(state="completed"),
                       messages=[A2AMessage(role="agent", parts=[TextPart(text=reply)])])
        return JsonRpcResponse(id=rid, result=task.model_dump()).model_dump()

    return app
