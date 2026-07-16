import * as cdk from 'aws-cdk-lib';
import { IngestStack } from '../lib/stacks/ingest-stack.js';
import { RagStack } from '../lib/stacks/rag-stack.js';
import { AgentStack } from '../lib/stacks/agent-stack.js';
import { ApiStack } from '../lib/stacks/api-stack.js';
import { AmplifyStack } from '../lib/stacks/amplify-stack.js';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-2',
};

// RagStack created first: IngestStack's processor Lambda reads its domain endpoint + IAM grant
// (design.md §4, brief constraint 8). IngestStack still deploys standalone if RagStack is ever
// omitted here (`ragStack` is an optional prop — see ingest-stack.ts).
const ragStack = new RagStack(app, 'RagStack', { env });
new IngestStack(app, 'IngestStack', { env, ragStack });
new AgentStack(app, 'AgentStack', { env });
new ApiStack(app, 'ApiStack', { env });
new AmplifyStack(app, 'AmplifyStack', { env });
