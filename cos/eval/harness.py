"""Competency-question evaluation harness.

Builds the KB, runs the baseline methods over the 16 labeled scenarios, scores them against
ground truth, and prints a scoreboard + per-scenario failures. This is the number the Claude
brain must move.

Run: ``python -m cos.eval.harness``  (starts the mock itself)
"""

from __future__ import annotations

from collections import defaultdict

from cos.eval import ground_truth as gt
from cos.eval import methods
from cos.eval.metrics import accuracy, op_family, prf, recall_at, token_overlap
from cos.kb.build import KB, build_kb
from cos.mocks.serve import run_mock


def evaluate(kb: KB) -> dict:
    cases = gt.cases(kb)
    r = {}

    # Q9 — action + Asana-op accuracy (+ Q11 NEEDS_INPUT P/R)
    action_pairs, op_pairs, rows = [], [], []
    pred_needs, gold_needs = set(), set()
    for c in cases:
        if c.trigger is None:
            continue
        pack = kb.retriever.context_pack(c.trigger)
        rec = methods.recommend(c.trigger, pack, kb)
        action_pairs.append((rec.action.value, c.action))
        op_pairs.append((op_family(rec.asana_op.value), op_family(c.asana)))
        if rec.action.value == "NEEDS_INPUT":
            pred_needs.add(c.key)
        if c.action == "NEEDS_INPUT":
            gold_needs.add(c.key)
        ok = "✓" if rec.action.value == c.action else "✗"
        rows.append((ok, c.key, c.action, rec.action.value,
                     op_family(c.asana), op_family(rec.asana_op.value)))
    r["action"] = accuracy(action_pairs)
    r["op"] = accuracy(op_pairs)
    r["needs_input"] = prf(pred_needs, gold_needs)
    r["rows"] = rows

    # Q7 — matter-linking: for each multi-channel matter, does the graph link the
    # declared channels to one person? (Recall over the labeled cross-channel matters.)
    multi = [c for c in cases if len(c.channels) > 1 and c.trigger]
    linked = 0
    for c in multi:
        chans = {c.trigger.channel.value} | {x.channel.value
                                             for x in kb.retriever.cross_channel(c.trigger)}
        if set(c.channels) <= chans:
            linked += 1
    r["cross"] = (linked, len(multi))

    # Q8 — task/milestone hit-rate@1  &  Q4 — context recall (hero scenarios)
    hit, total = 0, 0
    ctx_found, ctx_expected = set(), set()
    for c in cases:
        expected = c.milestone or c.task
        if not expected or c.trigger is None:
            continue
        total += 1
        top = kb.retriever.top_task(c.trigger)
        if top and token_overlap(top.name, expected):
            hit += 1
        if c.hero:
            ctx_expected.add((c.key, "task"))
            pack = kb.retriever.context_pack(c.trigger)
            if any(token_overlap(t.name, expected) for t in pack.related_tasks):
                ctx_found.add((c.key, "task"))
            if len(c.channels) > 1:
                ctx_expected.add((c.key, "cross"))
                if pack.cross_channel:
                    ctx_found.add((c.key, "cross"))
    r["task_hit"] = (hit, total)
    r["ctx_recall"] = recall_at(ctx_found, ctx_expected)

    # Q3 — stale-outbound (follow-up) recall
    r["stale"] = len(kb.graph.stale_outbound())

    # Q5 — hard facts: avg statements per message
    counts = [len(kb.retriever.facts(c.trigger)) for c in cases if c.trigger]
    r["facts_avg"] = sum(counts) / len(counts) if counts else 0.0

    # Q12 — dashboard counts
    r["dashboard"] = {
        "messages": len(kb.messages),
        "awaiting": len(kb.graph.awaiting_threads()),
        "milestones": len(kb.graph.milestones()),
        "tasks": len(kb.graph.tasks),
    }
    return r


def _pct(cf):  # (correct, total) -> "c/t (xx%)"
    c, t = cf
    return f"{c}/{t} ({(100*c/t if t else 0):.0f}%)"


def print_report(r: dict) -> None:
    print("=" * 64)
    print("COMPETENCY EVAL — baseline (rules + graph + vector, no LLM)")
    print("=" * 64)
    print(f"Q9  action accuracy        {_pct(r['action'])}")
    print(f"Q9  asana-op accuracy      {_pct(r['op'])}")
    p, rc, f1 = r["needs_input"]
    print(f"Q11 NEEDS_INPUT  P/R/F1    {p:.2f} / {rc:.2f} / {f1:.2f}")
    print(f"Q7  cross-channel link     {_pct(r['cross'])}")
    print(f"Q8  task/milestone hit@1   {_pct(r['task_hit'])}")
    print(f"Q4  context recall (hero)  {r['ctx_recall']:.2f}")
    print(f"Q3  stale-outbound found   {r['stale']}")
    print(f"Q5  hard facts / message   {r['facts_avg']:.1f} avg")
    print(f"Q12 dashboard              {r['dashboard']}")
    print("-" * 64)
    print("Q9 per-scenario (action):")
    for ok, key, exp, pred, eop, pop in r["rows"]:
        flag = "" if ok == "✓" else f"   [op exp={eop} pred={pop}]"
        print(f"  {ok} {key:22s} exp={exp:16s} pred={pred:16s}{flag}")


def main() -> None:
    with run_mock(port=8900):
        kb = build_kb()
        report = evaluate(kb)
    print_report(report)


if __name__ == "__main__":
    main()
