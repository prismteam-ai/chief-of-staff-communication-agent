FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e

WORKDIR /workspace

RUN npm install --global corepack@0.34.6 \
  && corepack prepare pnpm@10.33.0 --activate

COPY . .

RUN corepack pnpm install --frozen-lockfile

CMD ["sh", "-c", "test \"$(node --version)\" = \"v22.18.0\" && test \"$(corepack --version)\" = \"0.34.6\" && test \"$(pnpm --version)\" = \"10.33.0\" && pnpm verify"]
