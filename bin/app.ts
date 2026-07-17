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
// AgentStack (Task 5) depends on IngestStack for the communications table and (optionally) RagStack
// for the retrieval endpoint. The Ingest↔Agent trigger queue is referenced by deterministic name on
// the ingest side (see ingest-stack.ts / agent-stack.ts) so there is no CloudFormation cycle.
const ingestStack = new IngestStack(app, 'IngestStack', { env, ragStack });
new AgentStack(app, 'AgentStack', { env, ingestStack, ragStack });
// ApiStack (Task 6) depends on IngestStack for the communications + accounts tables the approval
// loop reads/writes and the account permission guard's ownership lookup; ragStack (Task 10) wires
// the feedback loop's exemplar indexing (optional — see api-stack.ts's ragStack prop doc).
new ApiStack(app, 'ApiStack', { env, ingestStack, ragStack });
new AmplifyStack(app, 'AmplifyStack', { env });
