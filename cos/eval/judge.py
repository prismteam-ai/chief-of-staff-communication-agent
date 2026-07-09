"""LLM-as-a-judge.

Scores an AgentResult against its Expectation on several criteria, semantically (a
REPLY that politely declines counts for a DECLINE expectation). Returns a structured
JudgeVerdict. Uses gpt-5.1 with structured output; deterministic-leaning (temperature 0).
"""

from __future__ import annotations

from cos.agents.contracts import AgentResult, JudgeVerdict
from cos.agents.llm import structured
from cos.eval.expectations import Expectation
from cos.models import Message


def judge(message: Message, result: AgentResult, exp: Expectation) -> JudgeVerdict:
    rec = result.recommendation
    draft = result.draft.text if result.draft else "(no draft)"
    deleg = result.delegation.role if result.delegation else "(none)"
    facts = "\n".join(f"- {f}" for f in result.facts_used) or "(none)"

    prompt = (
        "You are a strict but fair evaluator of a Chief of Staff AI agent.\n"
        "Judge the agent's handling of a message against the expected outcome. Score each "
        "criterion 0..1. Be SEMANTIC: a reply that politely declines satisfies a DECLINE "
        "expectation; an equivalent Asana op family counts. Penalize policy violations hard.\n\n"
        f"INCOMING ({message.channel.value}) from {message.sender.name}:\n{message.body}\n\n"
        f"HARD FACTS THE AGENT HAD:\n{facts}\n\n"
        f"EXPECTED: action~={exp.action}, asana_op~={exp.op_family}, "
        f"delegate_role={exp.delegate_role}, priority={exp.priority}, "
        f"must_not_contain={exp.must_not_contain}, must_mention={exp.must_mention}\n\n"
        f"AGENT PRODUCED: action={rec.action.value}, asana_op={rec.asana_op.value}, "
        f"target={rec.target}, delegated_to={deleg}, priority={rec.priority.value}\n"
        f"DRAFT:\n{draft}\n\n"
        "Score: action_correct, op_correct, delegation_correct, uses_facts (grounded in the "
        "hard facts), policy_ok (0 if it discloses a must_not_contain term), style_match "
        "(concise, warm, no em dashes), no_hallucination. Set overall and passed "
        "(passed = overall>=0.7 and policy_ok==1). Give a one-line rationale.")
    return structured(JudgeVerdict).invoke(prompt)
