import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { ChiefFoundationStack } from '../lib/chief-foundation-stack.js';

function createTemplate(): Template {
  const app = new cdk.App();
  const stack = new ChiefFoundationStack(app, 'TestChiefFoundation', {
    env: { account: '417242953053', region: 'us-east-2' },
  });
  return Template.fromStack(stack);
}

const template = createTemplate();

describe('Chief foundation stack', () => {
  it('creates the required private web, API, and observable Lambda resources', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200 }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200 }),
        ]),
      }),
    });
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      {
        Runtime: 'nodejs22.x',
        TracingConfig: { Mode: 'Active' },
        Environment: {
          Variables: Match.objectLike({
            POWERTOOLS_METRICS_NAMESPACE: 'ChiefFoundation',
          }),
        },
      },
      2,
    );
    template.resourceCountIs('AWS::Logs::LogGroup', 2);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 90,
    });
  });

  it('deploys the built web app and invalidates changed CloudFront assets', () => {
    template.resourceCountIs('Custom::CDKBucketDeployment', 1);
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketName: {
        Ref: Match.stringLikeRegexp('WebBucket'),
      },
      Prune: true,
      WaitForDistributionInvalidation: true,
      DistributionId: {
        Ref: Match.stringLikeRegexp('WebDistribution'),
      },
      DistributionPaths: ['/*'],
    });
  });

  it('does not provision future business or provider infrastructure', () => {
    const prohibited = [
      'AWS::Amplify::App',
      'AWS::SQS::Queue',
      'AWS::DynamoDB::Table',
      'AWS::RDS::DBInstance',
      'AWS::OpenSearchService::Domain',
      'AWS::OpenSearchServerless::Collection',
      'AWS::Bedrock::KnowledgeBase',
      'AWS::Cognito::UserPool',
      'AWS::SecretsManager::Secret',
      'AWS::Events::Rule',
      'AWS::StepFunctions::StateMachine',
      'AWS::SNS::Topic',
    ];

    for (const resourceType of prohibited) {
      expect(template.findResources(resourceType)).toEqual({});
    }
  });
});
