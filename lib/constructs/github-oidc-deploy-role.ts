import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

const GITHUB_OIDC_ISSUER_URL = 'https://token.actions.githubusercontent.com';

export interface GitHubOidcDeployRoleProps {
  /** `owner/repo` this role trusts, e.g. `jzubielik/chief-of-staff-communication-agent`. */
  readonly githubRepo: string;
  readonly roleName: string;
}

/**
 * Small shared construct: GitHub Actions OIDC provider + a deploy role
 * trusted for this repo only (`repo:<githubRepo>:*`), so
 * `ci-cd-dev.yml` / `ci-cd-prod.yml` can call
 * `aws-actions/configure-aws-credentials` without long-lived AWS keys.
 * The resulting role ARN is published as a CfnOutput to be recorded as the
 * `AWS_DEPLOY_ROLE_ARN` repository variable (one-time manual step).
 */
export class GitHubOidcDeployRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: GitHubOidcDeployRoleProps) {
    super(scope, id);

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

    // Scaffold-stage scope: broad enough to deploy all five stacks
    // end to end. Tighten to least-privilege as later tasks add resource
    // types (documented follow-up, not a Task 1 blocker).
    this.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'));
  }
}
