FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/asana/package.json packages/asana/
COPY packages/brain/package.json packages/brain/
COPY packages/connectors/package.json packages/connectors/
COPY packages/db/package.json packages/db/
COPY packages/rag-cli/package.json packages/rag-cli/
COPY packages/shared/package.json packages/shared/
COPY tests/package.json tests/
COPY infra/package.json infra/

RUN pnpm install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages

RUN pnpm --filter @indeedee/api... build

RUN mkdir -p /app/data

ENV PORT=8787 \
    API_BASE_URL=http://localhost:8787 \
    INDEEDEE_SSO_ENABLED=false \
    INDEEDEE_BRAIN_MODE=rules \
    INDEEDEE_DB_URL=file:/app/data/indeedee.db \
    SYNC_INTERVAL_MS=0

EXPOSE 8787

CMD ["node", "apps/api/dist/local-server.js"]
