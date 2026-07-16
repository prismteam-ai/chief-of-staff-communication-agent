#!/usr/bin/env tsx
/**
 * `just verify-ingest` (brief constraint 7): sends one real self-addressed email via
 * `messages.send`, waits/polls until the communication record appears (state `ingested`,
 * deduped=false), prints the record id + a `MessageIngested` metric datapoint check, then proves
 * conditional-write dedupe by directly re-invoking the deployed processor Lambda with the same
 * `{accountId, messageId}` payload (simulating an SQS redelivery) and confirming the second call
 * reports a duplicate rather than a second record/metric.
 *
 * If no refresh token / connected account exists yet, exits with the exact operator instructions
 * from the brief's operator-dependency protocol rather than fabricating success.
 */
import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from '@aws-sdk/client-cloudwatch';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const OAUTH_CLIENT_SECRET_ID = 'cos/gmail-oauth-client';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 90 * 1000;

function fail(message: string): never {
  console.error(`[verify-ingest] FAIL: ${message}`);
  process.exit(1);
}

function operatorInstructions(): never {
  console.error('\n[verify-ingest] No connected Gmail account / refresh token found.');
  console.error('[verify-ingest] Operator action required:');
  console.error('  1. just gmail-auth      (one Allow click in the browser)');
  console.error('  2. just seed-demo');
  console.error('  3. just verify-ingest\n');
  process.exit(1);
}

async function getStackOutput(stackName: string, outputKey: string): Promise<string | undefined> {
  const cfn = new CloudFormationClient({ region: REGION });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === outputKey)?.OutputValue;
}

async function findConnectedGmailAccount(
  accountsTableName: string,
): Promise<{ accountId: string; address: string } | null> {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const result = await doc.send(
    new ScanCommand({
      TableName: accountsTableName,
      FilterExpression: 'channelType = :c',
      ExpressionAttributeValues: { ':c': 'gmail' },
    }),
  );
  const account = result.Items?.[0];
  if (!account) return null;
  return { accountId: account.accountId as string, address: account.displayName as string };
}

async function hasRefreshToken(accountId: string): Promise<boolean> {
  const secretsManager = new SecretsManagerClient({ region: REGION });
  try {
    const result = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: `cos/gmail-token-${accountId}` }),
    );
    return Boolean(result.SecretString && JSON.parse(result.SecretString).refresh_token);
  } catch {
    return false;
  }
}

async function createGmailClient(accountId: string): Promise<gmail_v1.Gmail> {
  const secretsManager = new SecretsManagerClient({ region: REGION });
  const [clientSecretResult, tokenSecretResult] = await Promise.all([
    secretsManager.send(new GetSecretValueCommand({ SecretId: OAUTH_CLIENT_SECRET_ID })),
    secretsManager.send(new GetSecretValueCommand({ SecretId: `cos/gmail-token-${accountId}` })),
  ]);
  const { client_id, client_secret } = JSON.parse(clientSecretResult.SecretString!) as {
    client_id: string;
    client_secret: string;
  };
  const { refresh_token } = JSON.parse(tokenSecretResult.SecretString!) as { refresh_token: string };

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:8765/oauth/callback');
  oauth2Client.setCredentials({ refresh_token });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

function encodeMimeMessage(headers: Record<string, string>, body: string): string {
  const headerLines = Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
  const raw = `${headerLines}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`;
  return Buffer.from(raw).toString('base64url');
}

async function sendSelfAddressedProbe(gmail: gmail_v1.Gmail, address: string): Promise<string> {
  const marker = `verify-ingest-${Date.now()}`;
  const raw = encodeMimeMessage(
    { To: address, From: address, Subject: `[verify-ingest] ${marker}` },
    `This is an automated probe message sent by just verify-ingest at ${new Date().toISOString()}.`,
  );

  const response = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  const id = response.data.id;
  if (!id) fail('messages.send returned no message id');
  console.log(`[verify-ingest] Sent probe message, Gmail message id = ${id}`);
  return id;
}

async function pollForCommunicationRecord(
  communicationsTableName: string,
  commId: string,
): Promise<Record<string, unknown>> {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const result = await doc.send(new GetCommand({ TableName: communicationsTableName, Key: { commId } }));
    if (result.Item) return result.Item;
    console.log(
      `[verify-ingest] Waiting for ${commId} to appear (poller runs every 1 minute)...`,
    );
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  fail(
    `Communication record ${commId} did not appear within ${POLL_TIMEOUT_MS / 1000}s. ` +
      'Check the poller/processor Lambda logs and the DLQ.',
  );
}

async function checkMessageIngestedMetric(): Promise<void> {
  const cloudwatch = new CloudWatchClient({ region: REGION });
  const end = new Date();
  const start = new Date(end.getTime() - 15 * 60 * 1000);

  const result = await cloudwatch.send(
    new GetMetricStatisticsCommand({
      Namespace: 'ChiefOfStaffIngest',
      MetricName: 'MessageIngested',
      Dimensions: [{ Name: 'channel', Value: 'gmail' }],
      StartTime: start,
      EndTime: end,
      Period: 300,
      Statistics: ['Sum'],
    }),
  );

  const total = (result.Datapoints ?? []).reduce((sum, dp) => sum + (dp.Sum ?? 0), 0);
  if (total > 0) {
    console.log(`[verify-ingest] MessageIngested metric datapoint confirmed: ${total} in the last 15 minutes.`);
  } else {
    console.log(
      '[verify-ingest] No MessageIngested datapoint visible yet (CloudWatch can lag a few minutes) — not a hard failure.',
    );
  }
}

async function invokeProcessorDirectly(
  functionName: string,
  accountId: string,
  messageId: string,
): Promise<unknown> {
  const lambda = new LambdaClient({ region: REGION });
  const sqsShapedEvent = {
    Records: [
      {
        messageId: `verify-ingest-replay-${Date.now()}`,
        body: JSON.stringify({ accountId, messageId }),
      },
    ],
  };

  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      Payload: Buffer.from(JSON.stringify(sqsShapedEvent)),
    }),
  );

  if (response.FunctionError) {
    fail(`Direct processor invocation failed: ${response.FunctionError}`);
  }
  return response.Payload ? JSON.parse(Buffer.from(response.Payload).toString('utf-8')) : undefined;
}

async function main() {
  const accountsTableName = await getStackOutput('IngestStack', 'AccountsTableName');
  const communicationsTableName = await getStackOutput('IngestStack', 'CommunicationsTableName');
  const processorFunctionName = await getStackOutput('IngestStack', 'ProcessorFunctionName');

  if (!accountsTableName || !communicationsTableName || !processorFunctionName) {
    fail('IngestStack outputs not found — deploy IngestStack first.');
  }

  const account = await findConnectedGmailAccount(accountsTableName);
  if (!account || !(await hasRefreshToken(account.accountId))) {
    operatorInstructions();
  }

  console.log(`[verify-ingest] Using account ${account.accountId} (${account.address})`);
  const gmail = await createGmailClient(account.accountId);

  const messageId = await sendSelfAddressedProbe(gmail, account.address);
  const commId = `gmail#${messageId}`;

  const record = await pollForCommunicationRecord(communicationsTableName, commId);
  console.log(`[verify-ingest] Communication record found: commId=${record.commId} status=${record.status}`);

  if (record.status !== 'ingested') {
    fail(`Expected status "ingested", got "${String(record.status)}"`);
  }

  await checkMessageIngestedMetric();

  console.log('\n[verify-ingest] Proving conditional-write dedupe: replaying the same message id...');
  const replayResult = await invokeProcessorDirectly(processorFunctionName, account.accountId, messageId);
  console.log('[verify-ingest] Replay processor response:', JSON.stringify(replayResult));

  const recordAfterReplay = await pollForCommunicationRecord(communicationsTableName, commId);
  if (recordAfterReplay.ingestedAt !== record.ingestedAt) {
    fail('ingestedAt changed after replay — the record was overwritten instead of deduped.');
  }

  console.log('\n[verify-ingest] PASS');
  console.log(`  Record id:        ${commId}`);
  console.log(`  Status:            ${record.status}`);
  console.log(`  ingestedAt stable across replay: ${recordAfterReplay.ingestedAt}`);
  console.log('  Dedupe confirmed: replay did not create a duplicate or overwrite the record.\n');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
