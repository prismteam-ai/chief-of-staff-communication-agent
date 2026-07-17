import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PROJECT_NAME } from './tags.js';

const GITHUB_OIDC_ISSUER_URL = 'https://token.actions.githubusercontent.com';

/** Matches `justfile`'s `CDK_BOOTSTRAP_QUALIFIER:-hnb659fds` default — the standard modern-bootstrap
 * qualifier this account was bootstrapped with. */
const CDK_QUALIFIER = 'hnb659fds';

export interface GitHubOidcDeployRoleProps {
  /** `owner/repo` this role trusts, e.g. `jzubielik/chief-of-staff-communication-agent`. */
  readonly githubRepo: string;
  readonly roleName: string;
}

/**
 * Small shared construct: GitHub Actions OIDC provider + a deploy role trusted for this repo only
 * (`repo:<githubRepo>:*`), so `ci-cd-dev.yml` / `ci-cd-prod.yml` can call
 * `aws-actions/configure-aws-credentials` without long-lived AWS keys. The resulting role ARN is
 * published as a CfnOutput to be recorded as the `AWS_DEPLOY_ROLE_ARN` repository variable
 * (one-time manual step).
 *
 * ## Reduced privilege, self-modification denied (slowking fix 4; see docs/FOLLOWUPS.md)
 * This role used to carry the `AdministratorAccess` managed policy — scaffold-stage scope, "tighten
 * later" documented as a follow-up that was never done. Replaced with an inline policy scoped to
 * what `just deploy` (`cdk deploy --all` + `scripts/deploy-web.ts` + `scripts/smoke.ts` +
 * `scripts/write-web-env.ts`, all run under this same role's credentials in CI) actually calls:
 *
 *  - **CloudFormation**: stack lifecycle, scoped to this project's 5 stacks + the `CDKToolkit`
 *    bootstrap stack (read-only there — `DescribeStacks`/`GetTemplate`, never create/update/delete).
 *  - **STS `AssumeRole` on the CDK bootstrap roles** (deploy/file-publishing/image-publishing/
 *    lookup) — the actual mechanism a modern-bootstrapped `cdk deploy` uses to perform every
 *    resource mutation: once assumed, those roles' OWN (CDK-managed, not touched by this policy)
 *    permissions do the real work, so THIS role's direct grants below are a defense-in-depth
 *    ceiling, not the only thing standing between a compromised token and the account.
 *  - **SSM `GetParameter` on `/cdk-bootstrap/*`**: `cdk` checks the bootstrap stack's version via
 *    SSM directly with the base credential, before it ever assumes a bootstrap role — omitting this
 *    breaks every `cdk` command, not just deploy.
 *  - **The CDK asset S3 bucket** (`cdk-<qualifier>-assets-<account>-<region>`): belt-and-suspenders
 *    alongside the file-publishing-role delegation above.
 *  - **The services each stack actually provisions**, scoped to this project's resources wherever a
 *    stable name/prefix exists (`${PROJECT_NAME}-*` DynamoDB tables/SQS queues/the OpenSearch
 *    domain/CloudWatch dashboards+alarms/log groups, the `cos/*` Secrets Manager secrets read-only,
 *    the Amplify app): **DynamoDB, S3 (the app's own raw-artifact bucket), OpenSearch, Lambda,
 *    API Gateway (HTTP APIs), IAM (for the roles those Lambdas/schedules run as), Secrets Manager
 *    (read only — this app never creates/writes a secret; every `cos/*` secret is
 *    operator-provisioned), CloudWatch (dashboards/alarms/logs), Amplify, SQS, EventBridge
 *    Scheduler (`scheduler.CfnSchedule` — the poller's `rate(1 minute)` trigger; this app has no
 *    classic EventBridge Rule), and Bedrock/Bedrock AgentCore** (the agent's `CfnMemory` resource +
 *    the pinned chat/embed model ARNs `agent-stack.ts`/`api-stack.ts` already scope their own
 *    Lambda execution-role grants to).
 *
 * **Documented tradeoff, not a full per-resource audit** (explicitly sanctioned for this fix: "if a
 * tight policy risks breaking deploys, use a documented moderately-scoped policy"): Lambda function
 * ARNs and IAM role/policy ARNs are scoped to this account+region but NOT to a stable name prefix,
 * because none of the `NodejsFunction`s in this repo set an explicit `functionName` (CDK
 * auto-generates one per logical id + stack + hash), so a name-prefix ARN pattern would be guessing
 * at an unstable string. Follow-up (not this fix): set explicit, `${PROJECT_NAME}`-prefixed
 * `functionName`/`roleName` everywhere, then tighten these two statements to match — or add IAM
 * permission boundaries. `cdk synth --strict` passes with this policy; a real deploy exercise only
 * happens through CI on push (not run here — no push without separate explicit approval).
 *
 * **The unresolved edge from that tradeoff**: the account-wide `role/*` IAM grant matches this
 * role's OWN ARN, so `iam:PutRolePolicy`/`iam:AttachRolePolicy` on itself would have been a
 * one-call return to full admin. The `DenySelfModification` statement below closes exactly that —
 * an explicit Deny on this role's own ARN, which always wins over the broad Allow. It does NOT
 * address the broader gap that these grants (and `lambda:*`/`iam:PassRole`) are account-wide
 * rather than name-prefixed; see `docs/FOLLOWUPS.md` for the honest accounting of what's left.
 */
export class GitHubOidcDeployRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: GitHubOidcDeployRoleProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const account = stack.account;
    const region = stack.region;

    const provider = new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
      url: GITHUB_OIDC_ISSUER_URL,
      clientIds: ['sts.amazonaws.com'],
    });

    this.role = new iam.Role(this, 'DeployRole', {
      roleName: props.roleName,
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:*`,
        },
      }),
      description: 'Assumed by GitHub Actions (OIDC) to run just deploy against this account.',
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // --- CloudFormation: this project's 5 stacks (full lifecycle) + CDKToolkit (read-only) -------
    const projectStackArns = [
      'RagStack',
      'IngestStack',
      'AgentStack',
      'ApiStack',
      'AmplifyStack',
    ].map(
      (stackName) =>
        `arn:${stack.partition}:cloudformation:${region}:${account}:stack/${stackName}/*`,
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudFormationProjectStacks',
        actions: [
          'cloudformation:CreateStack',
          'cloudformation:UpdateStack',
          'cloudformation:DeleteStack',
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:DescribeStackResource',
          'cloudformation:DescribeStackResources',
          'cloudformation:GetTemplate',
          'cloudformation:GetTemplateSummary',
          'cloudformation:CreateChangeSet',
          'cloudformation:DescribeChangeSet',
          'cloudformation:ExecuteChangeSet',
          'cloudformation:DeleteChangeSet',
          'cloudformation:ListStackResources',
          'cloudformation:ValidateTemplate',
          'cloudformation:TagResource',
          'cloudformation:UntagResource',
        ],
        resources: projectStackArns,
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudFormationBootstrapReadOnly',
        actions: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
        resources: [
          `arn:${stack.partition}:cloudformation:${region}:${account}:stack/CDKToolkit/*`,
        ],
      }),
    );

    // --- CDK bootstrap delegation: the actual mechanism `cdk deploy` mutates resources through ---
    const bootstrapRole = (name: string) =>
      `arn:${stack.partition}:iam::${account}:role/cdk-${CDK_QUALIFIER}-${name}-role-${account}-${region}`;
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [
          bootstrapRole('deploy'),
          bootstrapRole('file-publishing'),
          bootstrapRole('image-publishing'),
          bootstrapRole('lookup'),
        ],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CdkBootstrapVersionCheck',
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:${stack.partition}:ssm:${region}:${account}:parameter/cdk-bootstrap/${CDK_QUALIFIER}/version`,
        ],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CdkAssetBucket',
        actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:GetBucketLocation'],
        resources: [
          `arn:${stack.partition}:s3:::cdk-${CDK_QUALIFIER}-assets-${account}-${region}`,
          `arn:${stack.partition}:s3:::cdk-${CDK_QUALIFIER}-assets-${account}-${region}/*`,
        ],
      }),
    );

    // --- DynamoDB: every ${PROJECT_NAME}-* table (data-tables.ts) + its GSIs -----------------------
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DynamoDbProjectTables',
        actions: ['dynamodb:*'],
        resources: [
          `arn:${stack.partition}:dynamodb:${region}:${account}:table/${PROJECT_NAME}-*`,
          `arn:${stack.partition}:dynamodb:${region}:${account}:table/${PROJECT_NAME}-*/index/*`,
        ],
      }),
    );

    // --- S3: this app's own raw-artifact bucket (data-tables.ts) — NOT every bucket in the account -
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3ProjectBucket',
        actions: ['s3:*'],
        resources: [
          `arn:${stack.partition}:s3:::${PROJECT_NAME}-raw-artifacts-*`,
          `arn:${stack.partition}:s3:::${PROJECT_NAME}-raw-artifacts-*/*`,
        ],
      }),
    );

    // --- OpenSearch (rag-stack.ts's single domain) -------------------------------------------------
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'OpenSearchProjectDomain',
        actions: ['es:*'],
        resources: [
          `arn:${stack.partition}:es:${region}:${account}:domain/${PROJECT_NAME}-rag`,
          `arn:${stack.partition}:es:${region}:${account}:domain/${PROJECT_NAME}-rag/*`,
        ],
      }),
    );

    // --- Lambda: account+region scoped (documented tradeoff — no stable name prefix; see class doc)
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LambdaAccountScoped',
        actions: ['lambda:*'],
        resources: [`arn:${stack.partition}:lambda:${region}:${account}:function:*`],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LambdaEventSourceMappingList',
        // ListEventSourceMappings/ListFunctions do not support resource-level restriction.
        actions: ['lambda:ListEventSourceMappings', 'lambda:ListFunctions'],
        resources: ['*'],
      }),
    );

    // --- API Gateway (HttpApi in api-stack.ts) — ARNs have no account segment by AWS convention ----
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ApiGatewayHttpApis',
        actions: ['apigateway:*'],
        resources: [
          `arn:${stack.partition}:apigateway:${region}::/apis`,
          `arn:${stack.partition}:apigateway:${region}::/apis/*`,
          `arn:${stack.partition}:apigateway:${region}::/tags/*`,
        ],
      }),
    );

    // --- IAM: account-scoped (documented tradeoff — see class doc); no user/group/root actions -----
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'IamRolesAndPoliciesAccountScoped',
        actions: [
          'iam:CreateRole',
          'iam:DeleteRole',
          'iam:GetRole',
          'iam:UpdateRole',
          'iam:UpdateAssumeRolePolicy',
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:GetRolePolicy',
          'iam:AttachRolePolicy',
          'iam:DetachRolePolicy',
          'iam:ListRolePolicies',
          'iam:ListAttachedRolePolicies',
          'iam:ListInstanceProfilesForRole',
          'iam:TagRole',
          'iam:UntagRole',
          'iam:PassRole',
          'iam:CreatePolicy',
          'iam:DeletePolicy',
          'iam:CreatePolicyVersion',
          'iam:DeletePolicyVersion',
          'iam:GetPolicy',
          'iam:GetPolicyVersion',
          'iam:ListPolicyVersions',
          'iam:CreateServiceLinkedRole',
        ],
        resources: [
          `arn:${stack.partition}:iam::${account}:role/*`,
          `arn:${stack.partition}:iam::${account}:policy/*`,
        ],
      }),
    );

    // --- DENY: this role may never modify ITS OWN identity (slowking-fixes Important #4 follow-up)
    // The broad `role/*` grant above (needed so CDK can manage this project's Lambda/scheduler
    // execution roles) also matches this role's OWN ARN, so without this statement a compromised
    // token could call `iam:PutRolePolicy`/`iam:AttachRolePolicy` on itself and grant itself full
    // admin in one call. An explicit Deny always wins over an Allow in IAM's evaluation, so this
    // closes that one-call self-escalation path without narrowing what the Allow above lets CDK do
    // to any OTHER (stack-owned) role — `cdk deploy` never mutates the deploy role itself, only
    // stack execution roles (e.g. `ApiStack-HandlerServiceRole-...`), which have different ARNs and
    // are unaffected by this Deny. `iam:CreatePolicyVersion`'s underlying resource type is a
    // customer-managed policy ARN, not a role ARN — this repo attaches no customer-managed policies
    // to itself (every policy on this role is CDK's own inline `DefaultPolicy`), so that entry is
    // included for completeness/future-proofing rather than closing a live gap today.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DenySelfModification',
        effect: iam.Effect.DENY,
        actions: [
          'iam:PutRolePolicy',
          'iam:AttachRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:PutRolePermissionsBoundary',
          'iam:DeleteRolePermissionsBoundary',
          'iam:CreatePolicyVersion',
        ],
        resources: [`arn:${stack.partition}:iam::${account}:role/${props.roleName}`],
      }),
    );

    // --- Secrets Manager: READ ONLY on this app's operator-provisioned cos/* secrets --------------
    // (api-stack.ts / ingest-stack.ts / agent-stack.ts all read `cos/gmail-*`, `cos/asana-*`,
    // `cos/twilio-whatsapp-*`, `cos/dashboard-login-*` — every one already exists; this app's own
    // Lambdas never create or write a secret, and neither does the deploy role.)
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SecretsManagerReadOnly',
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [`arn:${stack.partition}:secretsmanager:${region}:${account}:secret:cos/*`],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SecretsManagerList',
        // ListSecrets has no resource-level restriction support.
        actions: ['secretsmanager:ListSecrets'],
        resources: ['*'],
      }),
    );

    // --- CloudWatch dashboards/alarms (metrics-dashboard.ts, dlq-alarm.ts) + Lambda log groups -----
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchProjectDashboardsAndAlarms',
        actions: [
          'cloudwatch:PutDashboard',
          'cloudwatch:GetDashboard',
          'cloudwatch:DeleteDashboards',
          'cloudwatch:PutMetricAlarm',
          'cloudwatch:DeleteAlarms',
          'cloudwatch:DescribeAlarms',
          'cloudwatch:TagResource',
          'cloudwatch:UntagResource',
        ],
        resources: [
          `arn:${stack.partition}:cloudwatch::${account}:dashboard/${PROJECT_NAME}-*`,
          `arn:${stack.partition}:cloudwatch:${region}:${account}:alarm:${PROJECT_NAME}-*`,
        ],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchListDashboards',
        actions: ['cloudwatch:ListDashboards'],
        resources: ['*'],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LambdaLogGroups',
        actions: ['logs:*'],
        resources: [`arn:${stack.partition}:logs:${region}:${account}:log-group:/aws/lambda/*`],
      }),
    );

    // --- SNS: the DLQ alarm topics (dlq-alarm.ts) --------------------------------------------------
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SnsProjectTopics',
        actions: ['sns:*'],
        resources: [`arn:${stack.partition}:sns:${region}:${account}:${PROJECT_NAME}-*`],
      }),
    );

    // --- Amplify (amplify-stack.ts + scripts/deploy-web.ts's direct AmplifyClient calls) -----------
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AmplifyApp',
        actions: ['amplify:*'],
        resources: [`arn:${stack.partition}:amplify:${region}:${account}:apps/*`],
      }),
    );

    // --- SQS: every ${PROJECT_NAME}-* queue (ingest/agent queues + DLQs) ---------------------------
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SqsProjectQueues',
        actions: ['sqs:*'],
        resources: [`arn:${stack.partition}:sqs:${region}:${account}:${PROJECT_NAME}-*`],
      }),
    );

    // --- EventBridge Scheduler (ingest-stack.ts's poller `rate(1 minute)` trigger) ------------------
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EventBridgeScheduler',
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:GetSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
          'scheduler:TagResource',
        ],
        resources: [`arn:${stack.partition}:scheduler:${region}:${account}:schedule/*/*`],
      }),
    );

    // --- Bedrock / Bedrock AgentCore (agent-stack.ts's CfnMemory + the pinned chat/embed models) ----
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockAgentCoreMemory',
        actions: ['bedrock-agentcore:*'],
        resources: [`arn:${stack.partition}:bedrock-agentcore:${region}:${account}:*`],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockModelDescribe',
        // No CREATE actions — this app only ever reads model/inference-profile metadata at deploy
        // time (if at all); the actual InvokeModel calls are granted to each Lambda's OWN execution
        // role (see api-stack.ts/agent-stack.ts), never to this deploy role.
        actions: ['bedrock:GetFoundationModel', 'bedrock:GetInferenceProfile'],
        resources: [
          `arn:${stack.partition}:bedrock:*::foundation-model/*`,
          `arn:${stack.partition}:bedrock:${region}:${account}:inference-profile/*`,
        ],
      }),
    );
  }
}
