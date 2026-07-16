set dotenv-load := false

# Install dependencies
setup:
    pnpm install --frozen-lockfile
    npm install -g aws-cdk

# Check code formatting
format:
    pnpm exec prettier --check .

# Run linting
lint:
    pnpm turbo run lint

# Run type checking
type-check:
    pnpm turbo run typecheck
    pnpm exec tsc --noEmit -p tsconfig.json

# Run tests
test:
    pnpm turbo run test

# Build all packages and synth the CDK app
build:
    pnpm turbo run build
    cdk synth --strict \
      --context "@aws-cdk/core:bootstrapQualifier=${CDK_BOOTSTRAP_QUALIFIER:-hnb659fds}"

# Deploy every stack, then smoke-test the result
deploy:
    cdk deploy --all --require-approval never \
      --context "@aws-cdk/core:bootstrapQualifier=${CDK_BOOTSTRAP_QUALIFIER:-hnb659fds}"
    just deploy-web
    just smoke

# Build apps/web and push it to the repo-less Amplify app (manual zip deploy — documented adaptation)
deploy-web:
    pnpm exec tsx scripts/write-web-env.ts
    pnpm turbo run build --filter=@chief-of-staff/web --force
    pnpm exec tsx scripts/deploy-web.ts

# Curl the API health route and the Amplify URL; non-zero exit on failure
smoke:
    pnpm exec tsx scripts/smoke.ts

# One-time-per-mailbox Gmail OAuth: mints a refresh token, stores it in Secrets Manager,
# upserts the account record. Requires IngestStack deployed; operator clicks Allow once.
gmail-auth:
    pnpm exec tsx scripts/gmail-auth.ts

# Seeds realistic inbox threads + a sent-history corpus into the connected Gmail mailbox.
# Requires just gmail-auth first; degrades with a clear message if no account is connected.
seed-demo:
    pnpm exec tsx scripts/seed-demo.ts

# Live proof: sends a self-addressed probe message, polls until it is persisted as an
# `ingested` communication record, checks the MessageIngested metric, then proves
# conditional-write dedupe by replaying the same message id against the processor Lambda.
verify-ingest:
    pnpm exec tsx scripts/verify-ingest.ts

# Local-first RAG proof (brief constraint 2): starts Docker OpenSearch, embeds+indexes
# fixtures/rag/corpus.jsonl via real Bedrock, replays fixtures/rag/golden-queries.json against
# the SAME index mapping + query code the deployed adapter uses, tears the container down.
rag-replay-local:
    docker compose -f docker-compose.rag.yml up -d --wait
    pnpm exec tsx scripts/rag-replay.ts --mode=local
    docker compose -f docker-compose.rag.yml down -v

# Golden-query proof against the deployed OpenSearch domain (brief constraint 8) — same
# fixtures, same query code, real Bedrock embeddings, real managed OpenSearch. Requires RagStack
# deployed.
rag-replay-aws:
    pnpm exec tsx scripts/rag-replay.ts --mode=aws

# Idempotent, deterministic-id indexing of the seeded org-doc + preference fixtures into the
# deployed domain (brief constraint 6). Safe to re-run — chunk ids are content-hash-derived, so a
# re-run upserts rather than duplicating.
seed-org-knowledge:
    pnpm exec tsx scripts/seed-org-knowledge.ts
