#!/usr/bin/env tsx
/**
 * Manual Amplify deploy for the repo-less `AmplifyStack` fallback (design-
 * sanctioned adaptation — a GitHub OAuth connection needs interactive user
 * consent, which is not available in this environment).
 *
 * Flow: read the Amplify app id + branch from the deployed AmplifyStack
 * outputs -> zip apps/web/dist -> `create-deployment` -> PUT the zip to the
 * returned upload URL -> `start-deployment` -> poll until SUCCEED/FAILED.
 */
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as archiver from 'archiver';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  AmplifyClient,
  CreateDeploymentCommand,
  StartDeploymentCommand,
  GetJobCommand,
} from '@aws-sdk/client-amplify';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const WEB_DIST_DIR = join(REPO_ROOT, 'apps/web/dist');
const ZIP_PATH = join(REPO_ROOT, '.amplify-deploy.zip');
const REGION = process.env.AWS_REGION ?? 'us-east-2';
const BRANCH_NAME = 'main';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function fail(message: string): never {
  console.error(`[deploy-web] ${message}`);
  process.exit(1);
}

async function getStackOutput(stackName: string, outputKey: string): Promise<string> {
  const cfn = new CloudFormationClient({ region: REGION });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const output = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === outputKey);
  if (!output?.OutputValue) {
    fail(`Stack output ${outputKey} not found on ${stackName} — deploy the stacks first.`);
  }
  return output.OutputValue;
}

async function zipDist(): Promise<void> {
  if (!existsSync(WEB_DIST_DIR)) {
    fail(
      `${WEB_DIST_DIR} does not exist — run "pnpm turbo run build --filter=@chief-of-staff/web" first.`,
    );
  }
  await rm(ZIP_PATH, { force: true });
  await mkdir(dirname(ZIP_PATH), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(ZIP_PATH);
    const archive = new archiver.ZipArchive({ zlib: { level: 9 } });
    output.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(WEB_DIST_DIR, false);
    void archive.finalize();
  });
}

async function pollJob(amplify: AmplifyClient, appId: string, jobId: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { job } = await amplify.send(
      new GetJobCommand({ appId, branchName: BRANCH_NAME, jobId }),
    );
    const status = job?.summary?.status;
    console.log(`[deploy-web] job ${jobId} status: ${status}`);
    if (status === 'SUCCEED') return;
    if (status === 'FAILED' || status === 'CANCELLED') {
      fail(`Amplify deployment job ${jobId} ended with status ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  fail(`Timed out waiting for Amplify job ${jobId} to finish`);
}

async function main() {
  const appId = await getStackOutput('AmplifyStack', 'AmplifyAppId');
  console.log(`[deploy-web] Amplify app id: ${appId}`);

  await zipDist();
  console.log(`[deploy-web] zipped ${WEB_DIST_DIR} -> ${ZIP_PATH}`);

  const amplify = new AmplifyClient({ region: REGION });

  const { jobId, zipUploadUrl } = await amplify.send(
    new CreateDeploymentCommand({ appId, branchName: BRANCH_NAME }),
  );
  if (!jobId || !zipUploadUrl) {
    fail('create-deployment did not return a jobId/zipUploadUrl');
  }

  const zipBuffer = await readFile(ZIP_PATH);
  const putResponse = await fetch(zipUploadUrl, {
    method: 'PUT',
    body: zipBuffer,
    headers: { 'Content-Type': 'application/zip' },
  });
  if (!putResponse.ok) {
    fail(`PUT to zipUploadUrl failed: ${putResponse.status} ${putResponse.statusText}`);
  }
  console.log('[deploy-web] zip uploaded');

  await amplify.send(new StartDeploymentCommand({ appId, branchName: BRANCH_NAME, jobId }));
  console.log(`[deploy-web] started deployment job ${jobId}`);

  await pollJob(amplify, appId, jobId);
  console.log('[deploy-web] deployment SUCCEEDED');

  await rm(ZIP_PATH, { force: true });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
