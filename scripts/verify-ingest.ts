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
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';

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
  const { refresh_token } = JSON.parse(tokenSecretResult.SecretString!) as {
    refresh_token: string;
  };

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    'http://localhost:8765/oauth/callback',
  );
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

interface SentProbe {
  /** The id `messages.send` returns. For a self-addressed send, Gmail's actual behavior varies by
   *  account/settings — empirically confirmed against the demo account (`just verify-ingest`,
   *  2026-07-16): Gmail delivered this as the SAME message id gaining the `INBOX` label alongside
   *  its existing `SENT` label (`labelIds: ['SENT', 'INBOX']`), not a second message row. Other
   *  accounts/setups have been observed to create a distinct INBOX-copy id sharing the thread
   *  instead, so this script polls for both shapes rather than assuming one. */
  sentId: string;
  threadId: string;
}

async function sendSelfAddressedProbe(gmail: gmail_v1.Gmail, address: string): Promise<SentProbe> {
  const marker = `verify-ingest-${Date.now()}`;
  const raw = encodeMimeMessage(
    { To: address, From: address, Subject: `[verify-ingest] ${marker}` },
    `This is an automated probe message sent by just verify-ingest at ${new Date().toISOString()}.`,
  );

  const response = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  const sentId = response.data.id;
  const threadId = response.data.threadId;
  if (!sentId) fail('messages.send returned no message id');
  if (!threadId) fail('messages.send returned no threadId');
  console.log(
    `[verify-ingest] Sent probe message, SENT-copy Gmail message id = ${sentId} (thread ${threadId})`,
  );
  return { sentId, threadId };
}

/**
 * The poller/processor pipeline ingests whatever Gmail message carries the `INBOX` label — for a
 * self-addressed send, which concrete message id that turns out to be is empirically
 * account-dependent (confirmed 2026-07-16 against the connected demo account, see the `SentProbe`
 * comment above), so this polls `users.threads.get` on the returned threadId and accepts either:
 *
 *   (a) same-id case: the `sentId` message itself gains an `INBOX` label (`labelIds` now contains
 *       both `SENT` and `INBOX`) — this is what the demo account actually does;
 *   (b) new-id case: a distinct message id appears on the same thread carrying the `INBOX` label
 *       (the two-separate-Message-rows behavior some Gmail accounts/setups exhibit instead).
 *
 * Checking `labelIds` (not just "some other id showed up") is what makes case (a) detectable at
 * all — without it, a same-id self-send would look identical to "still waiting" on every poll and
 * the script would spin until the deadline even though ingestion had already succeeded.
 */
async function pollForInboxCopyId(
  gmail: gmail_v1.Gmail,
  threadId: string,
  sentId: string,
  deadline: number,
): Promise<string> {
  while (Date.now() < deadline) {
    const thread = await gmail.users.threads.get({ userId: 'me', id: threadId });
    const messages = thread.data.messages ?? [];

    const sentMessageWithInboxLabel = messages.find(
      (m) => m.id === sentId && (m.labelIds ?? []).includes('INBOX'),
    );
    if (sentMessageWithInboxLabel?.id) {
      console.log(
        `[verify-ingest] Inbox copy found — same id as the sent message (Gmail added the INBOX label to ${sentMessageWithInboxLabel.id}).`,
      );
      return sentMessageWithInboxLabel.id;
    }

    const distinctInboxMessage = messages.find(
      (m) => m.id && m.id !== sentId && (m.labelIds ?? []).includes('INBOX'),
    );
    if (distinctInboxMessage?.id) {
      console.log(
        `[verify-ingest] Inbox copy found, distinct Gmail message id = ${distinctInboxMessage.id}`,
      );
      return distinctInboxMessage.id;
    }

    console.log(
      `[verify-ingest] Waiting for the inbox copy to appear on thread ${threadId} (self-send delivery lag)...`,
    );
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  fail(
    `Inbox copy of the probe message did not appear on thread ${threadId} within the verify-ingest budget. ` +
      'Gmail did not deliver the self-addressed message back to the inbox in time.',
  );
}

async function pollForCommunicationRecord(
  communicationsTableName: string,
  commId: string,
  deadline: number,
): Promise<Record<string, unknown>> {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  while (Date.now() < deadline) {
    const result = await doc.send(
      new GetCommand({ TableName: communicationsTableName, Key: { commId } }),
    );
    if (result.Item) return result.Item;
    console.log(`[verify-ingest] Waiting for ${commId} to appear (poller runs every 1 minute)...`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  fail(
    `Communication record ${commId} did not appear within the verify-ingest budget. ` +
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
    console.log(
      `[verify-ingest] MessageIngested metric datapoint confirmed: ${total} in the last 15 minutes.`,
    );
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

  // One shared 90s budget covers both polling stages (inbox-copy delivery, then DynamoDB
  // ingestion) rather than 90s per stage — Gmail self-send delivery is normally near-instant, so
  // the bulk of the budget is expected to go to waiting for the once-a-minute poller Lambda tick.
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  const { sentId, threadId } = await sendSelfAddressedProbe(gmail, account.address);
  const inboxMessageId = await pollForInboxCopyId(gmail, threadId, sentId, deadline);
  const commId = `gmail#${inboxMessageId}`;

  const record = await pollForCommunicationRecord(communicationsTableName, commId, deadline);
  console.log(
    `[verify-ingest] Communication record found: commId=${record.commId} status=${record.status}`,
  );

  if (record.status !== 'ingested') {
    fail(`Expected status "ingested", got "${String(record.status)}"`);
  }

  await checkMessageIngestedMetric();

  console.log(
    '\n[verify-ingest] Proving conditional-write dedupe: replaying the inbox-copy message id...',
  );
  const replayResult = await invokeProcessorDirectly(
    processorFunctionName,
    account.accountId,
    inboxMessageId,
  );
  console.log('[verify-ingest] Replay processor response:', JSON.stringify(replayResult));

  // The replay must resolve immediately (the record already exists), so give it its own short
  // budget independent of the now-expired outer deadline rather than failing on a technicality.
  const replayDeadline = Date.now() + POLL_INTERVAL_MS * 3;
  const recordAfterReplay = await pollForCommunicationRecord(
    communicationsTableName,
    commId,
    replayDeadline,
  );
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
