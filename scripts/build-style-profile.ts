#!/usr/bin/env tsx
/**
 * `just build-style-profile` (brief constraint 4, Task 10): idempotent (re)build of the connected
 * demo user's style profile from their REAL Gmail SENT mailbox — the same mailbox `just seed-demo`
 * populated with a sent-history corpus in a consistent voice (design.md §6: "Demo users are
 * provisioned with a realistic sent-history corpus so learned style is demonstrable, not
 * asserted").
 *
 * Two outputs (design.md §6):
 *   (a) an extracted style CARD (tone, length, sign-off, formality, greeting) — one Bedrock
 *       `generateObject` call over a sample of sent replies, persisted to the style-profiles table.
 *   (b) every sampled sent reply indexed as a retrievable EXEMPLAR into the account-scoped RAG
 *       index (`sourceType: 'sent_style'`), so `draftReply`'s prompt can retrieve the most relevant
 *       ones at draft time.
 *
 * Idempotent: re-running re-extracts the card (a fresh LLM read of the current sent-history sample)
 * and re-indexes exemplars by their deterministic chunk id (upsert, never duplicate) — safe to run
 * after `just seed-demo` tops up the sent-history corpus.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { LanguageModel } from 'ai';
import {
  createGmailClientForAccount,
  normalizeGmailMessage,
  type GmailMessage,
} from '@chief-of-staff/connectors/gmail';
import {
  createSignedOpenSearchClient,
  OpenSearchRetrievalIndex,
} from '@chief-of-staff/rag/opensearch';
import {
  buildStyleProfile,
  createBedrockStyleCardExtractor,
  createStyleProfileRepo,
  type SentReplyInput,
  type StyleLogger,
  type StyleMetricsClient,
} from '@chief-of-staff/agent-handler/style';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
/** Pinned chat model — matches `apps/agent-handler/src/env.ts`'s default (Task 5/10). */
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID?.trim() || 'us.anthropic.claude-sonnet-4-6';
/** How many of the mailbox's most recent sent messages to pull as the sent-history corpus. */
const SENT_HISTORY_MAX = 50;
/** Matches `agent-stack.ts`'s `METRICS_NAMESPACE` — StyleProfileBuilt/StyleExemplarAdded/
 * StyleProfileBuildDuration are registered under the agent service's namespace (cloudwatch-metrics.json). */
const METRICS_NAMESPACE = 'ChiefOfStaffAgent';

/** Console-backed `StyleLogger` — this script is not a Lambda, so plain prefixed console output
 * stands in for Powertools structured logging (same choice `seed-demo.ts`/`sync-asana.ts` make). */
const scriptLogger: StyleLogger = {
  info: (message, meta) => console.log(`[build-style-profile] ${message}`, meta ?? ''),
  warn: (message, meta) => console.warn(`[build-style-profile] WARN: ${message}`, meta ?? ''),
};

/**
 * `PutMetricDataCommand`-backed `StyleMetricsClient` — same rationale as `sync-asana.ts`'s
 * `publishSyncMetric`: an operator script has no Powertools `Metrics` instance to flush, so each
 * `addMetric` call publishes immediately. A publish failure is logged and swallowed, never thrown —
 * the style profile build itself already succeeded by the time metrics are emitted.
 */
function createCloudWatchMetricsClient(): StyleMetricsClient {
  const cloudwatch = new CloudWatchClient({ region: REGION });
  return {
    addMetric(name, unit, value) {
      cloudwatch
        .send(
          new PutMetricDataCommand({
            Namespace: METRICS_NAMESPACE,
            MetricData: [{ MetricName: name, Unit: unit, Value: value }],
          }),
        )
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[build-style-profile] WARN: failed to publish ${name} metric: ${message}`);
        });
    },
  };
}

function fail(message: string): never {
  console.error(`[build-style-profile] FAIL: ${message}`);
  process.exit(1);
}

async function getStackOutput(stackName: string, outputKey: string): Promise<string | undefined> {
  const cfn = new CloudFormationClient({ region: REGION });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === outputKey)?.OutputValue;
}

/** Finds the first active Gmail account and its owning user; mirrors `seed-demo.ts`'s lookup. */
async function findConnectedGmailAccount(
  accountsTableName: string,
): Promise<{ accountId: string; userId: string; address: string } | null> {
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
  return {
    accountId: account.accountId as string,
    userId: account.userId as string,
    address: account.displayName as string,
  };
}

/** Pulls up to `SENT_HISTORY_MAX` messages from the mailbox's SENT label and normalizes each into
 * a `SentReplyInput` — the recipient becomes the first `to` participant (the `chunkSentReply`
 * recipient-similarity dimension, brief constraint 2(b)). */
async function loadSentHistory(accountId: string, address: string): Promise<SentReplyInput[]> {
  const gmail = await createGmailClientForAccount(accountId);
  const list = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['SENT'],
    maxResults: SENT_HISTORY_MAX,
  });

  const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
  if (ids.length === 0) {
    fail(
      `No SENT messages found in ${address} — run \`just seed-demo\` first (it seeds a sent-history corpus).`,
    );
  }

  const sentReplies: SentReplyInput[] = [];
  for (const id of ids) {
    const response = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const normalized = normalizeGmailMessage(response.data as GmailMessage, accountId);
    if (!normalized.body.trim()) continue;
    const recipient = normalized.participants.find((p) => p.role === 'to')?.id;
    sentReplies.push({
      sourceId: normalized.externalId,
      body: normalized.body,
      ts: normalized.ts,
      recipient,
    });
  }

  return sentReplies;
}

function buildChatModel(): LanguageModel {
  const bedrock = createAmazonBedrock({
    region: REGION,
    credentialProvider: fromNodeProviderChain(),
  });
  return bedrock(BEDROCK_MODEL_ID) as LanguageModel;
}

async function main() {
  const accountsTableName = await getStackOutput('IngestStack', 'AccountsTableName');
  const styleProfilesTableName = await getStackOutput('IngestStack', 'StyleProfilesTableName');
  const domainEndpoint = await getStackOutput('RagStack', 'DomainEndpoint');
  if (!accountsTableName)
    fail('IngestStack AccountsTableName output not found — deploy IngestStack first.');
  if (!styleProfilesTableName) {
    fail('IngestStack StyleProfilesTableName output not found — deploy IngestStack first.');
  }
  if (!domainEndpoint) fail('RagStack DomainEndpoint output not found — deploy RagStack first.');

  const account = await findConnectedGmailAccount(accountsTableName);
  if (!account) {
    fail('No connected Gmail account found. Run `just gmail-auth` first, then `just seed-demo`.');
  }

  console.log(
    `[build-style-profile] Building style profile for userId=${account.userId} (accountId=${account.accountId}, ${account.address})`,
  );

  const sentReplies = await loadSentHistory(account.accountId, account.address);
  console.log(`[build-style-profile] Loaded ${sentReplies.length} sent message(s) from SENT.`);

  const extractor = createBedrockStyleCardExtractor(buildChatModel());
  const styleProfileRepo = createStyleProfileRepo(styleProfilesTableName);
  const retrievalIndex = new OpenSearchRetrievalIndex(
    createSignedOpenSearchClient({ endpoint: domainEndpoint, region: REGION }),
  );
  await retrievalIndex.ensureIndex();

  const result = await buildStyleProfile(
    { userId: account.userId, accountId: account.accountId, sentReplies },
    {
      extractor,
      styleProfileRepo,
      retrievalIndex,
      log: scriptLogger,
      metricsClient: createCloudWatchMetricsClient(),
    },
  );

  console.log('\n[build-style-profile] Style card:');
  console.log(JSON.stringify(result.styleCard, null, 2));
  console.log(
    `\n[build-style-profile] PASS — style card persisted, ${result.exemplarsIndexed} exemplar(s) indexed.\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
