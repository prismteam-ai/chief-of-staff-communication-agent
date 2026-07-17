import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { MetricsDashboard } from '../constructs/metrics-dashboard.js';
import { GitHubOidcDeployRole } from '../constructs/github-oidc-deploy-role.js';
import { PROJECT_NAME } from '../constructs/tags.js';
import { TaggedStack } from '../constructs/tagged-stack.js';
import { AGENT_QUEUE_NAME } from './agent-stack.js';
import type { IngestStack } from './ingest-stack.js';
import type { RagStack } from './rag-stack.js';

const SERVICE_NAME = 'chief-of-staff-api';
const METRICS_NAMESPACE = 'ChiefOfStaffApi';
const GITHUB_REPO = 'jzubielik/chief-of-staff-communication-agent';
// Task 8.5: Secrets Manager id holding the demo dashboard login credential — a JSON array of
// `{ username, passwordHash, userId }` (routers/auth.ts's login procedure, dashboard-credentials.ts).
// Operator-provisioned, same "name-based grant with a wildcard suffix" pattern the Gmail/Asana/
// Twilio secrets below use (Secrets Manager appends a random suffix to every ARN).
const DASHBOARD_LOGIN_SECRET_ID = 'cos/dashboard-login';

// Final-review fix: the deployed Amplify dashboard's ACTUAL origin (`infra/run-records/
// first-deploy.md`) plus the two local dev-server origins (`apps/web`'s `vite dev`/`vite preview`
// defaults) — everything the browser dashboard is ever legitimately served from. `'*'` was
// previously safe in the sense that auth here is a Bearer token (`Authorization` header, never a
// cookie), so no origin can ride a logged-in browser's ambient credentials the way CORS wildcards
// are dangerous for cookie-authenticated APIs — but a wildcard still lets ANY origin's JS read this
// API's responses if it ever gets a token via other means (XSS on an unrelated site, a leaked
// token pasted into a malicious page's console). Naming the actual origins closes that off with no
// functional cost to the one real client.
const DASHBOARD_ORIGINS = [
  'https://main.dismzb3pzaz79.amplifyapp.com',
  'http://localhost:5173', // apps/web `vite dev` default port
  'http://localhost:4173', // apps/web `vite preview` default port
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_HANDLER_ENTRY = path.join(__dirname, '../../apps/api/src/handler.ts');
const WHATSAPP_WEBHOOK_HANDLER_ENTRY = path.join(
  __dirname,
  '../../apps/api/src/whatsapp-webhook-handler.ts',
);
const WHATSAPP_INBOUND_PATH = '/whatsapp/inbound';

export interface ApiStackProps extends cdk.StackProps {
  /**
   * IngestStack provides the communications + accounts tables the approval loop (Task 6) reads/
   * writes: `listCommunications`/`getCommunication`/every transition procedure, and the account
   * permission guard's ownership lookup. Optional so ApiStack still synthesizes standalone (same
   * pattern as AgentStack's `ragStack`/`ingestStack` props) — unset, the API Lambda's `requireEnv`
   * throws a clear error at first request rather than the stack failing to synthesize.
   */
  readonly ingestStack?: IngestStack;
  /**
   * RAG knowledge-layer domain the Task 10 feedback loop indexes new sent_style exemplars into.
   * Optional so ApiStack still synthesizes standalone; unset, `routers/index.ts`'s
   * `styleFeedbackHook()` resolves to `undefined` and `approveDraft` runs exactly as it did before
   * Task 10 (no feedback loop, never a hard failure).
   */
  readonly ragStack?: RagStack;
}

export class ApiStack extends TaggedStack {
  /** No custom domain — this account owns none; execute-api default URL is used (documented adaptation). */
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props?: ApiStackProps) {
    super(scope, id, props);

    // --- Agent queue reference (deterministic name — Task 6 review fix, supplyContext re-run) ---
    // AgentStack owns the queue; the API Lambda only publishes to it (the `supplyContext` re-run
    // hand-off — see approval-service.ts). Built from the shared deterministic name, NOT a
    // construct import of AgentStack, the same name-then-formatArn pattern `ingest-stack.ts` uses
    // for its own agent-trigger wiring — avoids an Api↔Agent CloudFormation dependency cycle.
    const agentQueueArn = cdk.Stack.of(this).formatArn({
      service: 'sqs',
      resource: AGENT_QUEUE_NAME,
    });
    const agentQueueUrl = `https://sqs.${this.region}.amazonaws.com/${this.account}/${AGENT_QUEUE_NAME}`;

    const handler = new nodejs.NodejsFunction(this, 'TrpcHandler', {
      entry: API_HANDLER_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: new logs.LogGroup(this, 'TrpcHandlerLogGroup', {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        // AWS_REGION is a reserved Lambda runtime key — CloudFormation rejects it in the
        // environment map. The Lambda runtime auto-injects it, so the design.md §12 "set
        // explicitly in every runtime" constraint (no us-east-1 fallback) is satisfied here
        // by the platform; the explicit setting applies to the non-Lambda runtimes (CI,
        // scripts, the CDK app), which all set it.
        NODE_OPTIONS: '--enable-source-maps',
        // Slowking fix 3: without this, tRPC's `isDev` default (`NODE_ENV !== 'production'`)
        // resolves to `true` on a Lambda that never otherwise sets `NODE_ENV`, and
        // `NODE_OPTIONS=--enable-source-maps` above then rewrites every leaked stack trace back to
        // the original `/apps/api/src/...` TS source paths — see trpc.ts's `errorFormatter` doc
        // comment for the full mechanism this closes.
        NODE_ENV: 'production',
        POWERTOOLS_SERVICE_NAME: SERVICE_NAME,
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
        // supplyContext's re-run hand-off (Task 6 review fix) — same deterministic-name wiring as
        // ingest-stack.ts's AGENT_QUEUE_URL, see the note above.
        AGENT_QUEUE_URL: agentQueueUrl,
        ...(props?.ingestStack
          ? {
              COMMUNICATIONS_TABLE_NAME: props.ingestStack.communicationsTableName,
              ACCOUNTS_TABLE_NAME: props.ingestStack.accountsTableName,
              // Task 10 feedback loop: bumps the style profile's sourceCount on a successful send.
              STYLE_PROFILES_TABLE_NAME: props.ingestStack.styleProfilesTableName,
              // Task 11: per-user MCP token issuance/verification (routers/mcp.ts). Task 8.5
              // reuses the SAME table for dashboard session tokens minted by routers/auth.ts.
              MCP_TOKENS_TABLE_NAME: props.ingestStack.mcpTokensTableName,
            }
          : {}),
        // Task 8.5: demo dashboard login credential (routers/auth.ts's login procedure) — see
        // the secretsmanager:GetSecretValue grant below for the matching resource ARN.
        DASHBOARD_LOGIN_SECRET_ID: DASHBOARD_LOGIN_SECRET_ID,
        // Task 10 feedback loop: indexes the sent reply as a new sent_style exemplar. Unset when
        // RagStack isn't wired for this deploy — `routers/index.ts`'s `styleFeedbackHook()` then
        // resolves to `undefined` and `approveDraft` runs with no feedback loop (never a failure).
        ...(props?.ragStack ? { RAG_DOMAIN_ENDPOINT: props.ragStack.domainEndpoint } : {}),
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        format: nodejs.OutputFormat.ESM,
        banner:
          "import { createRequire as topLevelCreateRequire } from 'module'; const require = topLevelCreateRequire(import.meta.url);",
      },
    });

    // --- IAM: approval loop reads/writes the communications+accounts tables, sends via Gmail ---
    if (props?.ingestStack) {
      handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
          resources: [
            props.ingestStack.communicationsTableArn,
            `${props.ingestStack.communicationsTableArn}/index/*`,
          ],
        }),
      );
      handler.addToRolePolicy(
        new iam.PolicyStatement({
          // `dynamodb:Scan` is Task 8's addition — `accounts-repo.ts#listByUser` backs the
          // connect-channel wizard's connected-accounts list (README L12). The accounts table has
          // no GSI on `userId` (see that repo's doc comment on the demo-scoped Scan-with-
          // FilterExpression tradeoff); `GetItem`/`Query` remain for the pre-existing per-account
          // ownership lookups the approval/Asana/metrics services use.
          actions: ['dynamodb:GetItem', 'dynamodb:Scan'],
          resources: [props.ingestStack.accountsTableArn],
        }),
      );
      // Task 10 feedback loop: read (getStyleProfile-equivalent lookups are agent-side only) +
      // write (bumpSourceCount) on style-profiles. No Scan/Query needed — `StyleProfileRepo` is a
      // single-item GetItem/PutItem repo keyed on `userId`, same access shape as `agent-stack.ts`.
      handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
          resources: [props.ingestStack.styleProfilesTableArn],
        }),
      );
      // Task 11: MCP token issuance (PutItem, conditional on no existing hash), verification
      // (GetItem), and best-effort lastUsedAt bookkeeping (UpdateItem) — `McpTokensRepo`'s three
      // operations, same single-table access shape as the style-profiles grant above.
      handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
          resources: [props.ingestStack.mcpTokensTableArn],
        }),
      );
    }

    // Task 10 feedback loop: RAG index access + Bedrock embed on the pinned Cohere profile (the
    // feedback loop chunks + embeds + indexes the sent reply exactly like `build-style-profile.ts`
    // does) — same grant shape as `agent-stack.ts`'s `retrieveContext` wiring.
    if (props?.ragStack) {
      props.ragStack.grantIndexAccess(handler);
      handler.addToRolePolicy(
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

    // Grant SendMessage on the agent queue by its deterministic ARN (see AGENT_QUEUE_URL note
    // above) — supplyContext's re-enqueue hand-off.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [agentQueueArn],
      }),
    );

    // Gmail send needs the same OAuth secrets the ingest poller/processor already read (Task 6
    // brief constraint 2/5: `gmail.send` scope already requested, no re-consent). Same
    // name-pattern grant `ingest-stack.ts` uses — Secrets Manager appends a random ARN suffix, so
    // a wildcard is required for a name-based grant.
    const gmailOAuthClientSecretArn = cdk.Stack.of(this).formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: 'cos/gmail-oauth-client-??????',
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    const gmailTokenSecretArnPattern = cdk.Stack.of(this).formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: 'cos/gmail-token-*',
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [gmailOAuthClientSecretArn, gmailTokenSecretArnPattern],
      }),
    );

    // Asana execution (Task 7, design.md §9): createAsanaFollowup/linkAsana are the ONLY code paths
    // that read `cos/asana` (operator-provisioned — pat/workspace_gid/project_gid) — the agent's
    // manageAsana tool never touches Asana at all (it only proposes). Every write and read is
    // confined to `project_gid`; there is no workspace-wide project or task listing anywhere in the
    // system (privacy scoping, non-negotiable — Task 7 brief).
    // Secrets Manager appends a random suffix to the ARN, same wildcard-by-name pattern as the
    // Gmail grants above.
    const asanaSecretArn = cdk.Stack.of(this).formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: 'cos/asana-??????',
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [asanaSecretArn],
      }),
    );

    // Task 8.5: dashboard login credential read — routers/auth.ts's login procedure is the ONLY
    // code path that reads this secret. Same wildcard-by-name grant pattern as the Gmail/Asana/
    // Twilio secrets above.
    const dashboardLoginSecretArn = cdk.Stack.of(this).formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: `${DASHBOARD_LOGIN_SECRET_ID}-??????`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [dashboardLoginSecretArn],
      }),
    );

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${PROJECT_NAME}-api`,
      corsPreflight: {
        allowOrigins: DASHBOARD_ORIGINS,
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Task 8.5 live-proof fix: `methods: [HttpMethod.ANY]` here used to include OPTIONS, which
    // routed every CORS preflight straight to the tRPC Lambda instead of letting API Gateway's own
    // `corsPreflight` mock integration answer it — the Lambda has no OPTIONS handling (tRPC treats
    // it as a real request with a missing content-type and 415s), so the preflight response never
    // carried "200 OK", and every browser POST mutation (login included) failed closed with a CORS
    // error before the real request was ever sent. GET queries were unaffected (a same-origin-safe
    // GET with no custom headers never triggers a preflight), which is why this was latent through
    // Task 8 — the dashboard's mutations were never actually exercised live from a browser before
    // this task's proof step. Listing every real method explicitly (never ANY) leaves OPTIONS on
    // this path unclaimed, so `corsPreflight` above's auto-generated OPTIONS route continues to
    // answer preflights directly at the gateway, exactly as it does for every route CDK adds this
    // way — see https://github.com/aws/aws-cdk/issues/22208 for the same failure mode elsewhere.
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
        apigwv2.HttpMethod.HEAD,
      ],
      integration: new integrations.HttpLambdaIntegration('LambdaIntegration', handler),
    });

    this.apiUrl = httpApi.apiEndpoint;

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.apiUrl,
      description:
        'Default execute-api URL — no custom domain owned by this account (documented adaptation).',
    });

    // --- WhatsApp inbound webhook (Task 9, brief constraint 3/4): a separate Lambda from the tRPC
    // handler above — Twilio POSTs application/x-www-form-urlencoded, not JSON-RPC, to a stable,
    // documented path on the SAME HttpApi (so the deployed apiUrl the operator configures in the
    // Twilio console never changes). ---
    const whatsappWebhookUrl = `${this.apiUrl}${WHATSAPP_INBOUND_PATH}`;

    const whatsappWebhookHandler = new nodejs.NodejsFunction(this, 'WhatsAppWebhookHandler', {
      entry: WHATSAPP_WEBHOOK_HANDLER_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: new logs.LogGroup(this, 'WhatsAppWebhookHandlerLogGroup', {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        // Slowking fix 3: same rationale as TrpcHandler above — belt-and-suspenders here since this
        // handler doesn't go through tRPC's error formatting, but keeps every Lambda in this stack
        // consistently non-verbose in production.
        NODE_ENV: 'production',
        POWERTOOLS_SERVICE_NAME: SERVICE_NAME,
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
        AGENT_QUEUE_URL: agentQueueUrl,
        // The webhook's own public URL — part of Twilio's signed data (verifyTwilioSignature MUST
        // be checked against the exact URL Twilio was configured to call).
        WHATSAPP_WEBHOOK_URL: whatsappWebhookUrl,
        ...(props?.ingestStack
          ? {
              COMMUNICATIONS_TABLE_NAME: props.ingestStack.communicationsTableName,
              DEDUPE_TABLE_NAME: props.ingestStack.dedupeTableName,
            }
          : {}),
        ...(props?.ragStack ? { RAG_DOMAIN_ENDPOINT: props.ragStack.domainEndpoint } : {}),
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        format: nodejs.OutputFormat.ESM,
        banner:
          "import { createRequire as topLevelCreateRequire } from 'module'; const require = topLevelCreateRequire(import.meta.url);",
      },
    });

    if (props?.ingestStack) {
      whatsappWebhookHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem'],
          resources: [props.ingestStack.communicationsTableArn],
        }),
      );
      whatsappWebhookHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem'],
          resources: [props.ingestStack.dedupeTableArn],
        }),
      );
    }

    if (props?.ragStack) {
      props.ragStack.grantIndexAccess(whatsappWebhookHandler);
      whatsappWebhookHandler.addToRolePolicy(
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

    whatsappWebhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [agentQueueArn],
      }),
    );

    // `cos/twilio-whatsapp` (operator-provisioned, verified live): { account_sid, auth_token,
    // sandbox_number } — read by both the inbound webhook (signature verification) and the send
    // path (whatsapp-send.ts). Secrets Manager appends a random suffix, same wildcard-by-name
    // pattern as the Gmail/Asana secret grants above.
    const twilioWhatsAppSecretArn = cdk.Stack.of(this).formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: 'cos/twilio-whatsapp-??????',
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    whatsappWebhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [twilioWhatsAppSecretArn],
      }),
    );
    // The tRPC handler's send path (whatsapp-send.ts, connectorFor) also reads this secret.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [twilioWhatsAppSecretArn],
      }),
    );

    httpApi.addRoutes({
      path: WHATSAPP_INBOUND_PATH,
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        'WhatsAppWebhookIntegration',
        whatsappWebhookHandler,
      ),
    });

    new cdk.CfnOutput(this, 'WhatsAppWebhookUrl', {
      value: whatsappWebhookUrl,
      description:
        'Paste as the WhatsApp sandbox "WHEN A MESSAGE COMES IN" webhook URL (Twilio console, Messaging > Try it out > Send a WhatsApp message) — POST, this exact URL.',
    });

    const { dashboard } = new MetricsDashboard(this, 'ApiMetricsDashboard', {
      dashboardName: `${PROJECT_NAME}-api`,
      namespace: METRICS_NAMESPACE,
      // Approval-loop metrics (Task 6, design.md §7) ride the same processed-vs-failed graph
      // shape as the generic request counters — DraftApproved/ReplySent/CommunicationDismissed on
      // the "processed" axis, SendFailed alongside RequestFailed on the "failed" axis. Asana
      // execution metrics (Task 7, design.md §9) join the same graph: AsanaTaskCreated/
      // AsanaTaskLinked/AsanaSyncCompleted/AsanaSyncTasksSynced/AsanaSyncChunksIndexed on
      // "processed", AsanaApiFailed/AsanaScopeViolationRejected alongside SendFailed on "failed"
      // (a scope-violation rejection is a security-relevant denial, not a transient API failure,
      // but it belongs on the same "something didn't go through" axis for at-a-glance visibility).
      processedMetricNames: [
        'RequestProcessed',
        'DraftApproved',
        'ReplySent',
        'CommunicationDismissed',
        'AsanaTaskCreated',
        'AsanaTaskLinked',
        'AsanaSyncCompleted',
        'AsanaSyncTasksSynced',
        'AsanaSyncChunksIndexed',
        // Task 10 feedback loop (design.md §6): one more exemplar indexed per successful
        // post-send hook call — same metric name as the agent service's build-time emission,
        // distinguished by namespace (see cloudwatch-metrics.json's two StyleExemplarAdded entries).
        'StyleExemplarAdded',
        // Task 9 WhatsApp: inbound webhook ingestion + outbound send successes join the same
        // processed axis as the Gmail-side equivalents (MessageIngested lives on the Ingest
        // dashboard; WhatsAppIngested is the api-side equivalent since the webhook Lambda lives
        // here — see whatsapp-webhook-handler.ts's doc comment for why).
        'WhatsAppIngested',
        'WhatsAppSent',
        // Task 11: MCP token issuance + every successful MCP-authenticated tool invocation join the
        // processed axis — the tRPC-level equivalent of the other channel-specific counters above.
        'McpTokenIssued',
        'McpToolInvoked',
        // Task 8.5: a successful dashboard login (mints a session token) + every dashboard tRPC
        // call that passed the bearer-token gate — the dashboard-side equivalent of the MCP
        // counters directly above (same shared authedMiddleware emits both).
        'SessionTokenIssued',
        'DashboardRequestAuthenticated',
      ],
      failedMetricNames: [
        'RequestFailed',
        'SendFailed',
        'AsanaApiFailed',
        'AsanaScopeViolationRejected',
        'StyleFeedbackFailed',
        'WhatsAppIngestFailed',
        'WhatsAppSendFailed',
        'WhatsAppSignatureRejected',
        // Task 8.5: rejected demo-login attempts (unknown username, wrong password) — the
        // dashboard-side equivalent of McpAuthFailed directly below.
        'DashboardAuthFailed',
        // Task 11: rejected MCP bearer tokens (forged, revoked, unknown) — the security-relevant
        // denial counter, same "denial belongs on the failed axis" precedent as
        // AsanaScopeViolationRejected above.
        'McpAuthFailed',
      ],
    });

    new cdk.CfnOutput(this, 'DashboardName', { value: dashboard.dashboardName });

    const { role: deployRole } = new GitHubOidcDeployRole(this, 'GitHubOidcDeployRole', {
      githubRepo: GITHUB_REPO,
      roleName: `${PROJECT_NAME}-github-actions-deploy`,
    });

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: deployRole.roleArn,
      description:
        'Set as the AWS_DEPLOY_ROLE_ARN repository variable for ci-cd-dev.yml / ci-cd-prod.yml.',
    });
  }
}
