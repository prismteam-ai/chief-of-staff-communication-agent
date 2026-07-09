"""In-memory vector index (cosine). Light stand-in for pgvector / OpenSearch.

Holds (vector, text, metadata) rows. `add` accumulates; `build` fits the embedder on the
whole corpus then vectorizes; `search` returns the top-k rows by cosine similarity.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from cos.kb.embeddings import EmbeddingProvider


@dataclass
class VectorIndex:
    embedder: EmbeddingProvider
    texts: list[str] = field(default_factory=list)
    metas: list[dict] = field(default_factory=list)
    _matrix: np.ndarray | None = None

    def add(self, text: str, meta: dict) -> None:
        self.texts.append(text)
        self.metas.append(meta)

    def build(self) -> None:
        self.embedder.fit(self.texts)
        vecs = [self.embedder.embed(t) for t in self.texts]
        self._matrix = np.vstack(vecs) if vecs else np.zeros((0, 0))

    def search(self, query: str, k: int = 5, kind: str | None = None) -> list[dict]:
        if self._matrix is None or self._matrix.size == 0:
            return []
        q = self.embedder.embed(query)
        sims = self._matrix @ q  # rows are unit-normalized -> dot == cosine
        order = np.argsort(-sims)
        out = []
        for i in order:
            if kind and self.metas[i].get("kind") != kind:
                continue
            out.append({"text": self.texts[i], "score": float(sims[i]), **self.metas[i]})
            if len(out) >= k:
                break
        return out
