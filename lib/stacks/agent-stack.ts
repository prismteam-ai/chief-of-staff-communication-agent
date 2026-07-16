import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { TaggedStack } from '../constructs/tagged-stack.js';

/**
 * Empty-but-deployable placeholder. Task 5 adds the agent-handler Lambda
 * (Bedrock via the Vercel AI SDK ToolLoopAgent) and its AgentCore Memory wiring.
 */
export class AgentStack extends TaggedStack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
