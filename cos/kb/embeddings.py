"""Embeddings behind one interface.

`LocalEmbedding` is a deterministic, keyless TF-IDF vectorizer — used for dev, CI, and the
eval harness so retrieval scores are reproducible without an API key. `OpenAIEmbedding` is the
production path. `get_embedder()` picks by MODE. Same `VectorIndex` code runs on either.
"""

from __future__ import annotations

import math
import re
from collections import Counter

import numpy as np

from cos.config import get_settings

_TOKEN = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall(text.lower())


class EmbeddingProvider:
    def fit(self, corpus: list[str]) -> None:  # optional (TF-IDF needs it)
        pass

    def embed(self, text: str) -> np.ndarray:
        raise NotImplementedError


class LocalEmbedding(EmbeddingProvider):
    """Deterministic TF-IDF vectors over a fitted vocabulary. No network, no key."""

    def __init__(self) -> None:
        self.vocab: dict[str, int] = {}
        self.idf: np.ndarray | None = None

    def fit(self, corpus: list[str]) -> None:
        df: Counter = Counter()
        docs = [set(_tokens(d)) for d in corpus]
        for d in docs:
            df.update(d)
        self.vocab = {t: i for i, t in enumerate(sorted(df))}
        n = len(corpus) or 1
        idf = np.zeros(len(self.vocab))
        for t, i in self.vocab.items():
            idf[i] = math.log((1 + n) / (1 + df[t])) + 1.0
        self.idf = idf

    def embed(self, text: str) -> np.ndarray:
        vec = np.zeros(len(self.vocab))
        if not self.vocab:
            return vec
        tf = Counter(t for t in _tokens(text) if t in self.vocab)
        for t, c in tf.items():
            vec[self.vocab[t]] = c
        vec = vec * self.idf
        norm = np.linalg.norm(vec)
        return vec / norm if norm else vec


class OpenAIEmbedding(EmbeddingProvider):
    """Real embeddings for the deployed run (text-embedding-3-small)."""

    def __init__(self, model: str = "text-embedding-3-small") -> None:
        from openai import OpenAI  # imported lazily so dev/CI never needs the package

        self.client = OpenAI()
        self.model = model

    def embed(self, text: str) -> np.ndarray:
        resp = self.client.embeddings.create(model=self.model, input=text)
        return np.array(resp.data[0].embedding)


def get_embedder() -> EmbeddingProvider:
    return LocalEmbedding() if get_settings().is_mock else OpenAIEmbedding()
