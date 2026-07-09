"""A generalization benchmark: adversarial / tricky messages NOT in the fixtures.

Every output must be a valid action, the result must be deterministic, and the rules
baseline must clear a modest bar. The genuinely hard cases (buried requests, implicit
signals) are where the LLM brain must improve — this set is the yardstick for that.
"""

from datetime import datetime, timezone

import pytest

from cos.eval import methods
from cos.kb.ontology import Action
from cos.models import Channel, Direction, Message, Participant

# (body, expected_action). Mix of clear and deliberately tricky.
GOLDEN = [
    ("URGENT!!! Limited-time: 10x your revenue, just add your card to start.", "FLAG_SPAM"),
    ("Any chance we can find 30 minutes next week to catch up?", "SCHEDULE_MEETING"),
    ("Could you make an introduction to your CFO?", "INTRODUCE"),
    ("How hard should we push on the liquidation preference?", "NEEDS_INPUT"),
    ("Quick question on the R&D tax credit for the Q2 filing.", "FORWARD"),
    ("We've decided to sunset the integration, no need to keep it open.", "REPLY"),
    # --- trickier: signal is implicit / buried ---
    ("Thanks so much! Before you go — the board packet is due Friday and I still "
     "need your revenue numbers.", "REPLY"),                 # request buried under thanks
    ("Our production API returned 500s for a full hour this morning.", "ESCALATE"),
    ("Would you comment on the rumors about layoffs at your company?", "DECLINE"),
    ("I'll take care of the vendor contract — nothing needed from you.", "NO_ACTION"),
]


def _msg(body, direction=Direction.incoming):
    return Message(id="t", channel=Channel.gmail, thread_id="t",
                   sender=Participant(id="email:x@y.z", name="X", email="x@y.z"),
                   timestamp=datetime.now(timezone.utc), body=body, direction=direction)


@pytest.fixture(scope="module")
def kb(mock_server):
    from cos.kb.build import build_kb
    from cos.mocks.store import store
    store.reset()
    return build_kb()


def test_all_outputs_valid_and_deterministic(kb):
    valid = {a.value for a in Action}
    first = []
    for body, _ in GOLDEN:
        m = _msg(body)
        rec = methods.recommend(m, kb.retriever.context_pack(m), kb)
        assert rec.action.value in valid
        first.append(rec.action.value)
    # determinism
    second = [methods.recommend(_msg(b), kb.retriever.context_pack(_msg(b)), kb).action.value
              for b, _ in GOLDEN]
    assert first == second


def test_baseline_generalization_bar(kb):
    hits, misses = 0, []
    for body, expected in GOLDEN:
        m = _msg(body)
        got = methods.recommend(m, kb.retriever.context_pack(m), kb).action.value
        if got == expected:
            hits += 1
        else:
            misses.append((expected, got, body[:40]))
    # the rules baseline should clear half; the LLM brain must close the rest.
    assert hits / len(GOLDEN) >= 0.5, f"only {hits}/{len(GOLDEN)}; misses={misses}"
