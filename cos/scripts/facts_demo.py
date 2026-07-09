"""Show the hard-facts layer for the hero scenarios.

Run: ``python -m cos.scripts.facts_demo``  (starts its own mock)
"""

from __future__ import annotations

from cos.eval import ground_truth as gt
from cos.kb.build import build_kb
from cos.mocks.serve import run_mock

HEROES = ("sarah-series-a", "customer-escalation", "podcast", "office-lease")


def main() -> None:
    with run_mock(port=8900):
        kb = build_kb()
        cases = {c.key: c for c in gt.cases(kb)}
        for key in HEROES:
            c = cases.get(key)
            if not c or not c.trigger:
                continue
            print("=" * 66)
            print(f"{key}  |  {c.trigger.channel.value}  |  from {c.trigger.sender.name}")
            print(f'  "{c.trigger.body[:90]}"')
            print("  HARD FACTS:")
            for f in kb.retriever.facts(c.trigger):
                print(f"    • {f}")


if __name__ == "__main__":
    main()
