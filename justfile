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
    pnpm turbo run build --filter=@chief-of-staff/web
    pnpm exec tsx scripts/deploy-web.ts

# Curl the API health route and the Amplify URL; non-zero exit on failure
smoke:
    pnpm exec tsx scripts/smoke.ts
