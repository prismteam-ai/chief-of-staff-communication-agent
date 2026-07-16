import * as cdk from 'aws-cdk-lib';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import { Construct } from 'constructs';
import { PROJECT_NAME } from '../constructs/tags.js';
import { TaggedStack } from '../constructs/tagged-stack.js';

/**
 * Repo-less Amplify app (design-sanctioned fallback — a GitHub OAuth
 * connection needs interactive user consent, which is not available here).
 * `apps/web` is built and deployed manually via `aws amplify
 * create-deployment` / `start-deployment` (see justfile `deploy` recipe and
 * `infra/run-records/first-deploy.md`).
 */
export class AmplifyStack extends TaggedStack {
  public readonly appId: string;
  public readonly branchName = 'main';
  public readonly defaultDomain: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const app = new amplify.CfnApp(this, 'WebApp', {
      name: `${PROJECT_NAME}-web`,
      // No repository configured — manual zip deployments only.
      customRules: [
        {
          source: '</^[^.]+$/>',
          target: '/index.html',
          status: '200',
        },
      ],
    });

    const branch = new amplify.CfnBranch(this, 'MainBranch', {
      appId: app.attrAppId,
      branchName: this.branchName,
      enableAutoBuild: false,
    });
    branch.addDependency(app);

    this.appId = app.attrAppId;
    this.defaultDomain = app.attrDefaultDomain;

    new cdk.CfnOutput(this, 'AmplifyAppId', { value: this.appId });
    new cdk.CfnOutput(this, 'AmplifyUrl', {
      value: `https://${this.branchName}.${this.defaultDomain}`,
      description:
        'Amplify branch URL — deployed manually (repo-less fallback, documented adaptation).',
    });
  }
}
