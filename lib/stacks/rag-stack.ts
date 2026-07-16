import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { TaggedStack } from '../constructs/tagged-stack.js';

/**
 * Empty-but-deployable placeholder. Task 4 adds the OpenSearch domain,
 * index mapping, and embedding pipeline wiring.
 */
export class RagStack extends TaggedStack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
