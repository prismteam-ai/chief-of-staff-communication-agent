#!/usr/bin/env tsx
/**
 * Post-deploy smoke test: hits the API health route and the Amplify URL,
 * exits non-zero on failure. Reads both URLs from the deployed CDK stack
 * outputs so it never depends on hardcoded infrastructure.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const REQUEST_TIMEOUT_MS = 15000;

function fail(message: string): never {
  console.error(`[smoke] FAIL: ${message}`);
  process.exit(1);
}

async function getStackOutput(stackName: string, outputKey: string): Promise<string> {
  const cfn = new CloudFormationClient({ region: REGION });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const output = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === outputKey);
  if (!output?.OutputValue) {
    fail(`Stack output ${outputKey} not found on ${stackName}`);
  }
  return output.OutputValue;
}

async function checkUrl(label: string, url: string, validate: (body: string) => boolean) {
  console.log(`[smoke] checking ${label}: ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      fail(`${label} returned HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    if (!validate(body)) {
      fail(`${label} response did not pass validation: ${body.slice(0, 200)}`);
    }
    console.log(`[smoke] OK ${label}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const apiUrl = await getStackOutput('ApiStack', 'ApiUrl');
  const amplifyUrl = await getStackOutput('AmplifyStack', 'AmplifyUrl');

  await checkUrl('API health route', `${apiUrl}/health.check`, (body) => {
    const parsed = JSON.parse(body) as { result?: { data?: { ok?: boolean; ts?: string } } };
    return parsed.result?.data?.ok === true && typeof parsed.result?.data?.ts === 'string';
  });

  await checkUrl('Amplify dashboard', amplifyUrl, (body) => body.length > 0);

  console.log('[smoke] all checks passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
