import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { PROJECT_NAME } from './tags.js';

/**
 * Base stack applying the `project_name` tag both at the CloudFormation
 * stack level (`StackProps.tags`) and as a CDK Tags Aspect so every taggable
 * resource created inside the stack inherits it too.
 */
export class TaggedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, {
      ...props,
      tags: { project_name: PROJECT_NAME, ...props?.tags },
    });
    cdk.Tags.of(this).add('project_name', PROJECT_NAME);
  }
}
