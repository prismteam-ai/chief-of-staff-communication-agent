"""Property-based fuzzing of the parsing/scoring primitives.

Random and adversarial strings must never crash these, and their invariants must always
hold — the kind of coverage example-based tests can't give.
"""

from datetime import datetime, timezone

import numpy as np
from hypothesis import given, settings
from hypothesis import strategies as st

from cos.eval.methods import classify_priority
from cos.eval.metrics import op_family, token_overlap
from cos.kb.embeddings import LocalEmbedding
from cos.kb.graph import _norm
from cos.kb.ontology import Priority
from cos.kb.retriever import DEADLINE_RE
from cos.models import Channel, Message, Participant

# realistic-ish text: printable, no surrogate code points
text = st.text(st.characters(blacklist_categories=("Cs",)), max_size=200)


def _msg(body: str) -> Message:
    return Message(id="m", channel=Channel.gmail, thread_id="t",
                   sender=Participant(id="p", name="P"), body=body,
                   timestamp=datetime.now(timezone.utc))


@given(text)
def test_classify_priority_total(t):
    assert isinstance(classify_priority(_msg(t)), Priority)


@given(text)
def test_deadline_regex_safe(t):
    m = DEADLINE_RE.search(t.lower())
    assert m is None or m.group(0) in t.lower()


@given(text)
def test_norm_idempotent(t):
    assert _norm(_norm(t)) == _norm(t)


@given(text, text)
def test_token_overlap_symmetric(a, b):
    assert token_overlap(a, b) == token_overlap(b, a)


@given(text)
def test_op_family_is_str(t):
    assert isinstance(op_family(t), str)


@settings(max_examples=60)
@given(st.lists(text, min_size=1, max_size=15), text)
def test_embedding_finite_and_bounded(corpus, query):
    emb = LocalEmbedding()
    emb.fit(corpus)
    v = emb.embed(query)
    assert np.isfinite(v).all()
    assert np.linalg.norm(v) <= 1.0001        # unit-normalized (or zero)
