import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-lambda-event-sources';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { CfnMemory } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import { TaggedStack } from '../constructs/tagged-stack.js';
import { DlqAlarm } from '../constructs/dlq-alarm.js';
import { MetricsDashboard } from '../constructs/metrics-dashboard.js';
import { PROJECT_NAME } from '../constructs/tags.js';
import type { IngestStack } from './ingest-stack.js';
import type { RagStack } from './rag-stack.js';

const SERVICE_NAME = 'chief-of-staff-agent';
const METRICS_NAMESPACE = 'ChiefOfStaffAgent';
/** Pinned chat model (kit skill + mission live-verified). Also used to build the invoke IAM scope. */
const BEDROCK_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
/** design.md §5: `LANGSMITH_PROJECT=pidgeot-agent`. */
const LANGSMITH_PROJECT = 'pidgeot-agent';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_HANDLER_ENTRY = path.join(__dirname, '../../apps/agent-handler/src/handler.ts');

/**
 * Deterministic name shared with `IngestStack` so the ingest processor can be granted
 * `sqs:SendMessage` on this queue's ARN WITHOUT a construct-level cross-reference (which would
 * create an Ingest↔Agent CloudFormation dependency cycle: AgentStack already depends on IngestStack
 * for the communications table name). The processor builds the queue URL from this same name.
 */
export const AGENT_QUEUE_NAME = `${PROJECT_NAME}-agent`;

export interface AgentStackProps extends cdk.StackProps {
  /** IngestStack provides the communications table (name + ARN) the agent reads/writes. Required. */
  readonly ingestStack: IngestStack;
  /**
   * RAG knowledge-layer domain the `retrieveContext` tool queries. Optional so AgentStack still
   * synthesizes standalone; unset, the agent runs with `RAG_DOMAIN_ENDPOINT` empty and degrades
   * gracefully (no retrieved context, never a hard failure).
   */
  readonly ragStack?: RagStack;
}

const BUNDLING: nodejs.BundlingOptions = {
  minify: true,
  sourceMap: true,
  target: 'node22',
  format: nodejs.OutputFormat.ESM,
  banner:
    "import { createRequire as topLevelCreateRequire } from 'module'; const require = topLevelCreateRequire(import.meta.url);",
};

/**
 * The agent brain (design.md §5, Task 5): the pidgeot agent runtime. Owns the AgentCore Memory
 * resource, the agent Lambda (Bedrock via the Vercel AI SDK ToolLoopAgent — NO direct
 * bedrock-runtime chat client), and the SQS trigger the ingest pipeline fans out to.
 *
 * ## Trigger design: SQS fan-out (chosen over a direct async invoke)
 * The ingest processor publishes `{commId, accountId}` to this stack's agent queue AFTER the
 * communication is durably persisted (the publish is isolated in `processor-logic.ts` the same way
 * RAG indexing is — a publish failure warns + counts, never fails ingestion). A dedicated queue was
 * chosen over a direct `InvokeCommand` because an agent turn runs a multi-second Bedrock tool loop:
 * blocking the ingest processor on it would risk the ingest queue's own visibility-timeout /
 * redelivery races, and a direct async invoke would give the agent turn NO retry/DLQ semantics of
 * its own. With the queue, the agent turn gets `ReportBatchItemFailures` → maxReceiveCount → this
 * stack's agent DLQ + the full stateful alarm, so an agent-turn failure is visible and retried,
 * never silently lost.
 *
 * The Ingest↔Agent cycle (Ingest needs Agent's queue; Agent needs Ingest's table) is broken by
 * granting/publishing against a DETERMINISTIC queue name/ARN rather than the construct — the same
 * name-then-formatArn pattern `ingest-stack.ts` already uses for the Gmail secret ARNs.
 */
export class AgentStack extends TaggedStack {
  public readonly agentQueueUrl: string;
  public readonly agentDlqUrl: string;
  public readonly memoryId: string;
  public readonly agentFunctionName: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    // --- AgentCore Memory (AI conversation history) -------------------------------------------

    const memory = new CfnMemory(this, 'AgentMemory', {
      name: `${PROJECT_NAME}_pidgeot_memory`.replace(/-/g, '_'),
      // Required prop. 90-day retention matches the log-retention posture elsewhere in this repo.
      eventExpiryDuration: 90,
      description: 'pidgeot agent conversation history (session = thread key, actor = sender).',
    });
    this.memoryId = memory.attrMemoryId;

    new cdk.CfnOutput(this, 'MemoryId', { value: this.memoryId });
    new cdk.CfnOutput(this, 'MemoryArn', { value: memory.attrMemoryArn });

    // --- Agent SQS queue + DLQ + the full alarm rule ------------------------------------------

    const dlq = new sqs.Queue(this, 'AgentDlq', {
      queueName: `${AGENT_QUEUE_NAME}-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    const agentQueue = new sqs.Queue(this, 'AgentQueue', {
      queueName: AGENT_QUEUE_NAME,
      // Comfortably above the agent Lambda's own timeout so an in-flight turn is never redelivered
      // mid-run (SQS best practice: visibility timeout >= function timeout).
      visibilityTimeout: cdk.Duration.seconds(180),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    this.agentQueueUrl = agentQueue.queueUrl;
    this.agentDlqUrl = dlq.queueUrl;

    new cdk.CfnOutput(this, 'AgentQueueUrl', { value: this.agentQueueUrl });
    new cdk.CfnOutput(this, 'AgentDlqUrl', { value: this.agentDlqUrl });

    const { topic: dlqAlarmTopic } = new DlqAlarm(this, 'AgentDlqAlarm', {
      dlq,
      alarmName: `${PROJECT_NAME}-agent-dlq-not-empty`,
      topicName: `${PROJECT_NAME}-agent-dlq-alarm`,
    });
    new cdk.CfnOutput(this, 'AgentDlqAlarmTopicArn', {
      value: dlqAlarmTopic.topicArn,
      description:
        'No subscriptions wired yet — PagerDuty subscription is production-gated (Task 13).',
    });

    // --- Optional LangSmith API key secret ----------------------------------------------------

    // Created only when LANGSMITH_API_KEY is present at deploy time (kit skill CDK pattern). Absent,
    // the agent runs with tracing gracefully disabled — LangSmith is fully optional/degradable.
    const langsmithApiKey = process.env.LANGSMITH_API_KEY?.trim();
    let langsmithSecret: secretsmanager.Secret | undefined;
    if (langsmithApiKey) {
      langsmithSecret = new secretsmanager.Secret(this, 'LangSmithApiKey', {
        secretName: `${PROJECT_NAME}/langsmith-api-key`,
        secretStringValue: cdk.SecretValue.unsafePlainText(langsmithApiKey),
      });
    }

    // --- Agent Lambda -------------------------------------------------------------------------

    const agentLogGroup = new logs.LogGroup(this, 'AgentHandlerLogGroup', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const agentHandler = new nodejs.NodejsFunction(this, 'AgentHandler', {
      entry: AGENT_HANDLER_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // A Bedrock tool loop is memory- and latency-sensitive: 1024MB gives the AI SDK + AWS SDKs
      // headroom, and 120s covers a multi-step classify+draft turn with retrieval well within the
      // 180s queue visibility timeout.
      memorySize: 1024,
      timeout: cdk.Duration.seconds(120),
      tracing: lambda.Tracing.ACTIVE,
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: agentLogGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: SERVICE_NAME,
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
        COMMUNICATIONS_TABLE_NAME: props.ingestStack.communicationsTableName,
        // Task 10 style seam: STYLE_PROFILES_TABLE_NAME/ACCOUNTS_TABLE_NAME let the agent Lambda
        // resolve accountId -> userId and read/build the learned style profile (design.md §6).
        STYLE_PROFILES_TABLE_NAME: props.ingestStack.styleProfilesTableName,
        ACCOUNTS_TABLE_NAME: props.ingestStack.accountsTableName,
        BEDROCK_MODEL_ID: BEDROCK_MODEL_ID,
        AGENTCORE_MEMORY_ID: this.memoryId,
        CHAT_HISTORY_EVENT_LIMIT: '200',
        LANGSMITH_PROJECT: LANGSMITH_PROJECT,
        LANGSMITH_ENDPOINT: 'https://api.smith.langchain.com',
        LANGSMITH_TRACING: 'true',
        ...(langsmithSecret ? { LANGSMITH_API_KEY_SECRET_ARN: langsmithSecret.secretArn } : {}),
        ...(props.ragStack ? { RAG_DOMAIN_ENDPOINT: props.ragStack.domainEndpoint } : {}),
      },
      bundling: BUNDLING,
    });

    this.agentFunctionName = agentHandler.functionName;

    // --- IAM -----------------------------------------------------------------------------------

    // Bedrock chat: InvokeModel(+stream) on the pinned Claude inference profile, plus the wildcard
    // foundation-model resource the `us.` profile forwards to across its member regions (same shape
    // as ingest-stack.ts's embed-model grant).
    agentHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'bedrock',
            region: 'us-east-2',
            resource: 'inference-profile',
            resourceName: BEDROCK_MODEL_ID,
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
        ],
      }),
    );

    // AgentCore Memory data-plane actions on this memory resource. The modern service prefix is
    // `bedrock-agentcore` (verified against `aws bedrock-agentcore` data-plane CLI: create-event,
    // list-events, list-sessions are real ops), NOT the kit skill doc's stale `bedrock:CreateEvent`.
    agentHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:ListSessions',
          'bedrock-agentcore:ListActors',
        ],
        resources: [memory.attrMemoryArn],
      }),
    );

    // DynamoDB read/write on the communications table (persist recommendation/draft/state).
    agentHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:PutItem', 'dynamodb:Query'],
        resources: [
          props.ingestStack.communicationsTableArn,
          `${props.ingestStack.communicationsTableArn}/index/*`,
        ],
      }),
    );

    // Task 10 style seam: read-only on accounts (accountId -> userId), read/write on style-profiles
    // (`getStyleProfile` reads; `just build-style-profile`'s CLI script and its underlying
    // `buildStyleProfile` orchestration — invoked from this same Lambda's code paths in tests, and
    // runnable standalone via `scripts/build-style-profile.ts` — write the extracted card).
    agentHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [props.ingestStack.accountsTableArn],
      }),
    );
    agentHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
        resources: [props.ingestStack.styleProfilesTableArn],
      }),
    );

    // RAG: grant OpenSearch HTTP access + Bedrock embed on the pinned Cohere profile (the
    // `retrieveContext` tool embeds the query then searches — reusing packages/rag's embed helper).
    if (props.ragStack) {
      props.ragStack.grantIndexAccess(agentHandler);
      agentHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: [
            cdk.Stack.of(this).formatArn({
              service: 'bedrock',
              region: 'us-east-2',
              resource: 'inference-profile',
              resourceName: 'us.cohere.embed-v4:0',
              arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
            }),
            'arn:aws:bedrock:*::foundation-model/cohere.embed-v4:0',
          ],
        }),
      );
    }

    // LangSmith secret read (only if the secret exists).
    langsmithSecret?.grantRead(agentHandler);

    // --- SQS trigger ---------------------------------------------------------------------------

    agentQueue.grantConsumeMessages(agentHandler);
    agentHandler.addEventSource(
      new events.SqsEventSource(agentQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
      }),
    );

    new cdk.CfnOutput(this, 'AgentFunctionName', { value: this.agentFunctionName });

    // --- Dashboard -----------------------------------------------------------------------------

    const { dashboard } = new MetricsDashboard(this, 'AgentMetricsDashboard', {
      dashboardName: `${PROJECT_NAME}-agent`,
      namespace: METRICS_NAMESPACE,
      processedMetricNames: ['RecommendationProduced', 'DraftProduced'],
      failedMetricNames: ['AgentTurnFailed', 'MemoryAppendFailed'],
      durationMetricName: 'AgentTurnDuration',
      titlePrefix: 'Agent',
    });
    new cdk.CfnOutput(this, 'AgentDashboardName', { value: dashboard.dashboardName });
  }
}
