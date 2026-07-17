#!/usr/bin/env tsx
/**
 * Writes `apps/web/.env.local` with `VITE_API_URL` sourced from the deployed `ApiStack`'s `ApiUrl`
 * output (Task 6, design.md §8), so the approval UI (`apps/web/src/lib/trpc-client.ts`) bakes in a
 * working API endpoint at build time — a reviewer never has to discover or type the API URL by hand.
 * Run before `pnpm turbo run build --filter=@chief-of-staff/web` in the `deploy-web` recipe.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ENV_FILE = join(REPO_ROOT, 'apps/web/.env.local');
const REGION = process.env.AWS_REGION ?? 'us-east-2';

function fail(message: string): never {
  console.error(`[write-web-env] ${message}`);
  process.exit(1);
}

async function getStackOutput(stackName: string, outputKey: string): Promise<string> {
  const cfn = new CloudFormationClient({ region: REGION });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const output = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === outputKey);
  if (!output?.OutputValue) {
    fail(`Stack output ${outputKey} not found on ${stackName} — deploy ApiStack first.`);
  }
  return output.OutputValue;
}

async function main() {
  const apiUrl = await getStackOutput('ApiStack', 'ApiUrl');
  await writeFile(ENV_FILE, `VITE_API_URL=${apiUrl}\n`, 'utf-8');
  console.log(`[write-web-env] wrote ${ENV_FILE} (VITE_API_URL=${apiUrl})`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
