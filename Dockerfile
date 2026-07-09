FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

# dependency layer (cached until lockfile changes)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

# application (no data/ — real-only, per-tenant; connectors resolve from the DB)
COPY README.md ./
COPY src ./src
COPY web ./web
COPY migrations ./migrations
COPY scripts ./scripts
RUN uv sync --frozen --no-dev

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["sh", "-c", "uv run uvicorn cos_agent.api:app --host 0.0.0.0 --port ${PORT:-8000}"]
