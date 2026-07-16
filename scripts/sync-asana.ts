#!/usr/bin/env tsx
/**
 * `just sync-asana` (Task 7 brief constraint 5, design.md §4/§9): idempotent, deterministic-id
 * indexing of the CoS Communication Agent's Asana project tasks into the deployed OpenSearch
 * domain — "extends the Task 4 corpus with live Asana context (tasks/projects/milestones/comments
 * indexed)".
 *
 * ## Scoping (privacy, non-negotiable)
 * Reads ONLY `AsanaClient.listCommunicationAgentTasks()` — `GET /projects/{project_gid}/tasks`,
 * paginated via `next_page.offset` to completion, NEVER a workspace-wide endpoint (the client has
 * no method that could reach outside `project_gid` at all). Every indexed chunk is stamped with the
 * demo account's `accountId` (resolved the same way `seed-demo.ts` resolves it: the first connected
 * Gmail account in the accounts table) so retrieval's mandatory account filter
 * (`RetrievalIndex.search`'s permission-boundary doc) still applies to Asana chunks exactly like
 * communication chunks — Asana context is scoped to the SAME demo account the rest of the corpus
 * belongs to, not a second, ungoverned tenant.
 *
 * ## Idempotency
 * `chunkAsanaTask` derives its id from `asana#<gid>` + a content hash of name+notes (`chunkIdFor`,
 * same scheme `chunkNormalizedMessage`/`seed-org-knowledge.ts` use) — indexing the same
 * unmodified task twice upserts the identical document rather than duplicating; re-running this
 * script (or a later re-sync after only some tasks changed) only ever creates NEW chunk ids for
 * tasks that actually changed content, never a duplicate of an unmodified task's chunk.
 *
 * Emits an `AsanaSyncCompleted` CloudWatch metric datapoint (namespace `ChiefOfStaffApi`, same
 * convention `cloudwatch-metrics.json` registers) via `PutMetricData` — this script runs from an
 * operator's machine, not a Lambda, so there is no Powertools `Metrics` instance to flush; a direct
 * `PutMetricDataCommand` is the equivalent for an operator-run script (`verify-ingest.ts` already
 * establishes the precedent of a script using `@aws-sdk/client-cloudwatch` directly, there to READ
 * a metric rather than write one).
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { AsanaClient } from '@chief-of-staff/connectors/asana';
import {
  createSignedOpenSearchClient,
  OpenSearchRetrievalIndex,
} from '@chief-of-staff/rag/opensearch';
import { embedTexts, EMBED_INPUT_TYPE, chunkAsanaTask } from '@chief-of-staff/rag';
import type { EmbeddedChunk } from '@chief-of-staff/rag';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const METRICS_NAMESPACE = 'ChiefOfStaffApi';

function fail(message: string): never {
  console.error(`[sync-asana] FAIL: ${message}`);
  process.exit(1);
}

async function getStackOutput(stackName: string, outputKey: string): Promise<string | undefined> {
  const cfn = new CloudFormationClient({ region: REGION });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === outputKey)?.OutputValue;
}

/** Same resolution `seed-demo.ts` uses: the first connected Gmail account in the accounts table —
 * the one demo account Asana context is scoped to (see module doc's scoping note). */
async function findDemoAccountId(): Promise<string | null> {
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
  return account ? (account.accountId as string) : null;
}

async function publishSyncMetric(taskCount: number, chunkCount: number): Promise<void> {
  const cloudwatch = new CloudWatchClient({ region: REGION });
  try {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: METRICS_NAMESPACE,
        MetricData: [
          { MetricName: 'AsanaSyncCompleted', Unit: 'Count', Value: 1 },
          { MetricName: 'AsanaSyncTasksSynced', Unit: 'Count', Value: taskCount },
          { MetricName: 'AsanaSyncChunksIndexed', Unit: 'Count', Value: chunkCount },
        ],
      }),
    );
  } catch (error) {
    // Isolated the same way the ingest processor isolates its post-persist metric/index steps
    // (ChunkIndexFailed doc comment) — a metrics-publish failure must never fail the sync itself,
    // which already completed successfully by the time this runs.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sync-asana] WARN: failed to publish AsanaSyncCompleted metric: ${message}`);
  }
}

async function main() {
  const accountId = await findDemoAccountId();
  if (!accountId) {
    fail('No connected Gmail account found — run just gmail-auth first.');
  }

  console.log('[sync-asana] listing tasks from the CoS Communication Agent Asana project...');
  const asanaClient = new AsanaClient();
  const tasks = await asanaClient.listCommunicationAgentTasks();
  console.log(`[sync-asana] fetched ${tasks.length} task(s) (paginated read, project-scoped only)`);

  const now = new Date().toISOString();
  const chunks = tasks.flatMap((task) =>
    chunkAsanaTask({
      gid: task.gid,
      name: task.name,
      notes: task.notes,
      completed: task.completed,
      permalinkUrl: task.permalink_url,
      dueOn: task.due_on,
      ts: now,
      accountId,
    }),
  );

  if (chunks.length === 0) {
    console.log('[sync-asana] no non-empty tasks to index — nothing to do.');
    await publishSyncMetric(tasks.length, 0);
    console.log('\n[sync-asana] PASS — 0 chunk(s) upserted (empty or all-blank project).\n');
    return;
  }

  const endpoint = await getStackOutput('RagStack', 'DomainEndpoint');
  if (!endpoint) fail('RagStack DomainEndpoint output not found — is RagStack deployed?');

  const index = new OpenSearchRetrievalIndex(
    createSignedOpenSearchClient({ endpoint, region: REGION }),
  );
  await index.ensureIndex();

  const vectors = await embedTexts(
    chunks.map((c) => c.textForEmbedding),
    EMBED_INPUT_TYPE.document,
  );

  const embedded: EmbeddedChunk[] = chunks.map((c, i) => ({ ...c, embedding: vectors[i]! }));
  await index.indexChunks(embedded);

  for (const chunk of embedded) {
    console.log(`[sync-asana] indexed  ${chunk.chunkId}  (asanaGid=${chunk.metadata.asanaGid})`);
  }

  await publishSyncMetric(tasks.length, embedded.length);

  console.log(
    `\n[sync-asana] PASS — ${tasks.length} task(s) read, ${embedded.length} chunk(s) upserted into communications-chunks.\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
