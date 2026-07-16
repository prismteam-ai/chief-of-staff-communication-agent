import * as cdk from 'aws-cdk-lib';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { TaggedStack } from '../constructs/tagged-stack.js';
import { PROJECT_NAME } from '../constructs/tags.js';

/**
 * The knowledge-layer / RAG store (design.md §4, brief constraint 3): a single-node OpenSearch
 * Service domain hosting the `communications-chunks` index (mapping owned by
 * `@chief-of-staff/rag`'s `index-mapping.ts` — the same definition used by the Docker local
 * replay, so the deployed index and the local-proof index are provably the same shape).
 *
 * **Demo-scale deviations from a production topology (documented per the skill's "note
 * deviations" rule):**
 *  - `t3.small.search`, single node, no dedicated master, no multi-AZ (`zoneAwareness` off).
 *    A production domain would run >=3 data nodes across AZs with dedicated masters; this is a
 *    demo-scoped single point of failure traded for cost/setup time, matching `DataTables`'
 *    `PAY_PER_REQUEST`/`RemovalPolicy.DESTROY` demo-scoped precedent in `IngestStack`.
 *  - 10GB gp3 EBS — comfortably above what the fixture + live-demo corpus needs.
 *  - Access policy is scoped to the account root principal (resource-side); per-principal access
 *    is enforced identity-side instead — `grantIndexAccess` grants a specific IAM grantee (the
 *    processor Lambda's execution role, wired in `ingest-stack.ts`) `es:ESHttp*`, which is what
 *    actually authorizes its SigV4-signed calls.
 *  - `RemovalPolicy.DESTROY` — same throwaway-demo-environment rationale as `DataTables`.
 */
export class RagStack extends TaggedStack {
  public readonly domain: opensearch.Domain;
  public readonly domainEndpoint: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.domain = new opensearch.Domain(this, 'CommunicationsChunksDomain', {
      domainName: `${PROJECT_NAME}-rag`,
      version: opensearch.EngineVersion.OPENSEARCH_2_15,
      capacity: {
        dataNodeInstanceType: 't3.small.search',
        dataNodes: 1,
        // No dedicated master nodes — single-node demo topology (see class doc deviation note).
        masterNodes: 0,
        multiAzWithStandbyEnabled: false,
      },
      ebs: {
        volumeSize: 10,
        volumeType: cdk.aws_ec2.EbsDeviceVolumeType.GP3,
      },
      zoneAwareness: {
        enabled: false,
      },
      enforceHttps: true,
      nodeToNodeEncryption: true,
      encryptionAtRest: { enabled: true },
      // Fine-grained access control is not enabled for the demo (single account-root-scoped
      // resource policy below is the access boundary) — reduces setup surface for a demo domain.
      accessPolicies: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.AccountRootPrincipal()],
          actions: ['es:*'],
          resources: ['*'],
        }),
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.domainEndpoint = this.domain.domainEndpoint;

    new cdk.CfnOutput(this, 'DomainEndpoint', {
      value: this.domainEndpoint,
      description:
        'communications-chunks OpenSearch domain endpoint — consumed by the ingest processor Lambda (IngestStack) and by just rag-replay-aws.',
    });
    new cdk.CfnOutput(this, 'DomainArn', { value: this.domain.domainArn });
  }

  /** Grants an IAM grantee (e.g. the processor Lambda's execution role) HTTP access to the domain. */
  grantIndexAccess(grantee: iam.IGrantable): iam.Grant {
    return this.domain.grantReadWrite(grantee);
  }
}
