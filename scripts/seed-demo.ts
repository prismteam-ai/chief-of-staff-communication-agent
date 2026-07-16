#!/usr/bin/env tsx
/**
 * `just seed-demo` (brief constraint 6, plan.md Task 3): seeds realistic demo data into the
 * connected Gmail mailbox — inbox threads (scheduling, contract questions, a newsletter/FYI,
 * urgent escalations, an attachment) via `messages.insert`, plus a sent-history corpus with a
 * consistent voice via insert into SENT (feeds Task 10 style learning). Content lives in
 * `apps/ingest/fixtures/seed-demo/*.json`, not inline strings.
 *
 * Synthetic-but-realistic: every sender/recipient is an invented person at an invented company —
 * no third-party PII. Requires a connected account's refresh token (`just gmail-auth` first);
 * degrades with a clear message if none exists yet, per the brief's operator-dependency protocol.
 *
 * Idempotent in spirit, not strict dedupe: re-running adds another realistic batch (design.md
 * §11 "Demo data realism is continuous" — seeding tops up, it does not need to no-op on rerun).
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const FIXTURES_DIR = join(REPO_ROOT, 'apps/ingest/fixtures/seed-demo');

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const OAUTH_CLIENT_SECRET_ID = 'cos/gmail-oauth-client';

interface InboxThreadFixture {
  category: string;
  subject: string;
  from: { name: string; email: string };
  body: string;
  reply?: { from: { name: string; email: string }; body: string };
}

interface SentFixture {
  subject: string;
  to: { name: string; email: string };
  body: string;
}

function fail(message: string): never {
  console.error(`[seed-demo] FAIL: ${message}`);
  process.exit(1);
}

async function getStackOutput(stackName: string, outputKey: string): Promise<string | undefined> {
  const cfn = new CloudFormationClient({ region: REGION });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === outputKey)?.OutputValue;
}

/** Finds the first active Gmail account and its refresh token; null if no account is connected yet. */
async function findConnectedGmailAccount(): Promise<{ accountId: string; address: string } | null> {
  const accountsTableName = await getStackOutput('IngestStack', 'AccountsTableName');
  if (!accountsTableName) {
    fail('IngestStack AccountsTableName output not found — deploy IngestStack first.');
  }

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

async function createGmailClient(accountId: string): Promise<gmail_v1.Gmail> {
  const secretsManager = new SecretsManagerClient({ region: REGION });

  const [clientSecretResult, tokenSecretResult] = await Promise.all([
    secretsManager.send(new GetSecretValueCommand({ SecretId: OAUTH_CLIENT_SECRET_ID })),
    secretsManager.send(new GetSecretValueCommand({ SecretId: `cos/gmail-token-${accountId}` })),
  ]);

  if (!clientSecretResult.SecretString || !tokenSecretResult.SecretString) {
    fail(`Missing OAuth secret material for account ${accountId}`);
  }

  const { client_id, client_secret } = JSON.parse(clientSecretResult.SecretString) as {
    client_id: string;
    client_secret: string;
  };
  const { refresh_token } = JSON.parse(tokenSecretResult.SecretString) as { refresh_token: string };

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

function newMessageId(localPart: string): string {
  const unique = `${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  return `<${localPart}-${unique}@seed-demo.local>`;
}

async function insertInboxMessage(
  gmail: gmail_v1.Gmail,
  demoAddress: string,
  from: { name: string; email: string },
  subject: string,
  body: string,
  opts: { threadId?: string; inReplyTo?: string; references?: string } = {},
): Promise<{ id: string; threadId: string }> {
  const messageId = newMessageId('inbox');
  const headers: Record<string, string> = {
    'Message-ID': messageId,
    Date: new Date().toUTCString(),
    Subject: opts.threadId ? `Re: ${subject}` : subject,
    From: `${from.name} <${from.email}>`,
    To: demoAddress,
  };
  if (opts.inReplyTo) headers['In-Reply-To'] = opts.inReplyTo;
  if (opts.references) headers.References = opts.references;

  const raw = encodeMimeMessage(headers, body);

  const response = await gmail.users.messages.insert({
    userId: 'me',
    requestBody: {
      raw,
      threadId: opts.threadId,
      labelIds: ['INBOX', 'UNREAD'],
    },
  });

  const id = response.data.id;
  const threadId = response.data.threadId;
  if (!id || !threadId) throw new Error('messages.insert returned no id/threadId');
  return { id, threadId };
}

async function insertSentMessage(
  gmail: gmail_v1.Gmail,
  demoAddress: string,
  to: { name: string; email: string },
  subject: string,
  body: string,
): Promise<void> {
  const headers: Record<string, string> = {
    'Message-ID': newMessageId('sent'),
    Date: new Date().toUTCString(),
    Subject: subject,
    From: demoAddress,
    To: `${to.name} <${to.email}>`,
  };
  const raw = encodeMimeMessage(headers, body);

  await gmail.users.messages.insert({
    userId: 'me',
    requestBody: { raw, labelIds: ['SENT'] },
  });
}

async function main() {
  const account = await findConnectedGmailAccount();
  if (!account) {
    console.error('[seed-demo] No connected Gmail account found.');
    console.error('[seed-demo] Run `just gmail-auth` first (one Allow click), then re-run `just seed-demo`.');
    process.exit(1);
  }

  console.log(`[seed-demo] Seeding into ${account.address} (accountId=${account.accountId})`);
  const gmail = await createGmailClient(account.accountId);

  const inboxThreads = JSON.parse(
    await readFile(join(FIXTURES_DIR, 'inbox-threads.json'), 'utf-8'),
  ) as InboxThreadFixture[];
  const sentCorpus = JSON.parse(
    await readFile(join(FIXTURES_DIR, 'sent-corpus.json'), 'utf-8'),
  ) as SentFixture[];

  let inboxCount = 0;
  for (const thread of inboxThreads) {
    const original = await insertInboxMessage(gmail, account.address, thread.from, thread.subject, thread.body);
    inboxCount += 1;
    console.log(`[seed-demo] inbox: "${thread.subject}" (${thread.category}) -> ${original.id}`);

    if (thread.reply) {
      const originalMessageId = `<inbox-${original.id}@seed-demo.local>`; // best-effort, informational only
      await insertInboxMessage(gmail, account.address, thread.reply.from, thread.subject, thread.reply.body, {
        threadId: original.threadId,
        inReplyTo: originalMessageId,
        references: originalMessageId,
      });
      inboxCount += 1;
      console.log(`[seed-demo] inbox reply: "Re: ${thread.subject}" -> thread ${original.threadId}`);
    }
  }

  let sentCount = 0;
  for (const sent of sentCorpus) {
    await insertSentMessage(gmail, account.address, sent.to, sent.subject, sent.body);
    sentCount += 1;
    console.log(`[seed-demo] sent: "${sent.subject}"`);
  }

  console.log(`\n[seed-demo] Done. ${inboxCount} inbox messages, ${sentCount} sent messages.`);
  console.log('[seed-demo] The poller (rate(1 minute)) will pick up the inbox messages on its next tick.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
