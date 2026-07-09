"""Agent evaluation harness (eval-driven loop).

Runs the multi-agent brain over the labeled scenarios + the unseen tricky set, scores each with
the LLM judge (and the deterministic style_score), and prints an agent scoreboard next to the
rules baseline. This is the number we iterate the agents against.

Run (real gpt-5.1; mock started automatically): ``python -m cos.eval.agent_harness``
Set AGENT_EVAL_LIMIT=N to score only the first N scenarios (fast smoke run).
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

RUNS_DIR = Path(__file__).resolve().parents[2] / "runs"

from cos.agents import brain, style
from cos.agents.runtime import get_kb
from cos.eval import expectations, ground_truth as gt
from cos.eval import judge as judgemod
from cos.eval import methods
from cos.eval.expectations import Expectation
from cos.mocks.serve import run_mock
from cos.models import Channel, Direction, Message, Participant


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return round(sum(xs) / len(xs), 3) if xs else 0.0


def _msg(body):
    return Message(id="tricky", channel=Channel.gmail, thread_id="t",
                   sender=Participant(id="e:x@y.z", name="External", email="x@y.z"),
                   timestamp=datetime.now(timezone.utc), body=body,
                   direction=Direction.incoming)


def evaluate(kb, limit: int | None = None) -> dict:
    exps = {e.key: e for e in expectations.for_scenarios(kb)}
    cases = [c for c in gt.cases(kb) if c.trigger]
    if limit:
        cases = cases[:limit]

    rows, verdicts, records = [], [], []
    base_correct = 0
    for c in cases:
        r = brain.run(c.trigger, dry_run=True)
        v = judgemod.judge(c.trigger, r, exps[c.key])
        verdicts.append(v)
        sc = style.style_score(kb, r.draft.text) if r.draft else None
        base = methods.recommend(c.trigger, kb.retriever.context_pack(c.trigger), kb)
        base_correct += int(base.action.value == c.action)
        rows.append({"key": c.key, "exp": c.action, "agent": r.recommendation.action.value,
                     "overall": v.overall, "passed": v.passed, "policy": v.policy_ok,
                     "style": sc})
        records.append({"kind": "scenario", "key": c.key,
                        "channel": c.trigger.channel.value, "sender": c.trigger.sender.name,
                        "message": c.trigger.body,
                        "expected": {"action": c.action, "op": c.asana},
                        "agent": {"action": r.recommendation.action.value,
                                  "op": r.recommendation.asana_op.value,
                                  "target": r.recommendation.target,
                                  "draft": r.draft.text if r.draft else None,
                                  "delegation": r.delegation.role if r.delegation else None,
                                  "style_score": sc, "trace": r.trace},
                        "judge": v.model_dump(), "baseline_action": base.action.value})

    # generalization set
    tricky = expectations.TRICKY[:limit] if limit else expectations.TRICKY
    tricky_pass, tricky_rows = 0, []
    for body, exp_action in tricky:
        m = _msg(body)
        r = brain.run(m, dry_run=True)
        v = judgemod.judge(m, r, Expectation(key="tricky", action=exp_action, op_family=None,
                                             delegate_role=None, priority="medium"))
        ok = v.action_correct >= 0.5
        tricky_pass += int(ok)
        tricky_rows.append((ok, exp_action, r.recommendation.action.value, body[:40]))
        records.append({"kind": "tricky", "message": body,
                        "expected": {"action": exp_action},
                        "agent": {"action": r.recommendation.action.value,
                                  "draft": r.draft.text if r.draft else None,
                                  "trace": r.trace},
                        "judge": v.model_dump()})

    RUNS_DIR.mkdir(exist_ok=True)
    with open(RUNS_DIR / "agent_eval_traces.jsonl", "w") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")

    return {
        "n": len(rows),
        "agent_overall": _mean([r["overall"] for r in rows]),
        "agent_pass_rate": _mean([1.0 if r["passed"] else 0.0 for r in rows]),
        "policy_ok": _mean([v.policy_ok for v in verdicts]),
        "uses_facts": _mean([v.uses_facts for v in verdicts]),
        "style_match_judge": _mean([v.style_match for v in verdicts]),
        "style_score_det": _mean([r["style"] for r in rows]),
        "baseline_action_acc": (base_correct, len(rows)),
        "tricky": (tricky_pass, len(tricky_rows)),
        "tricky_rows": tricky_rows,
        "rows": rows,
    }


def print_report(r: dict) -> None:
    print("=" * 66)
    print("AGENT EVAL — multi-agent brain (gpt-5.1) vs rules baseline")
    print("=" * 66)
    bc, bn = r["baseline_action_acc"]
    print(f"scenarios scored           {r['n']}")
    print(f"judge overall (0-1)        {r['agent_overall']}")
    print(f"judge pass rate            {r['agent_pass_rate']}")
    print(f"policy respected           {r['policy_ok']}")
    print(f"grounded in hard facts     {r['uses_facts']}")
    print(f"style match (judge)        {r['style_match_judge']}")
    print(f"style score (deterministic){r['style_score_det']}")
    print(f"baseline action accuracy   {bc}/{bn}")
    tp, tn = r["tricky"]
    print(f"tricky (unseen) — AGENT    {tp}/{tn}   (rules baseline was 6/10)")
    print("-" * 66)
    for ok, exp, got, body in r["tricky_rows"]:
        print(f"  {'OK ' if ok else 'MISS'} exp={exp:16s} got={got:16s} | {body}")


def main() -> None:
    limit = int(os.environ["AGENT_EVAL_LIMIT"]) if os.environ.get("AGENT_EVAL_LIMIT") else None
    with run_mock(port=8900):
        report = evaluate(get_kb(), limit=limit)
    print_report(report)


if __name__ == "__main__":
    main()
