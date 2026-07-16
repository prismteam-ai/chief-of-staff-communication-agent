import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

export interface MetricsDashboardProps {
  /** Dashboard name shown in the CloudWatch console. */
  readonly dashboardName: string;
  /** CloudWatch namespace the API Lambda publishes metrics under. */
  readonly namespace: string;
}

/**
 * Small shared construct rendering the metrics registered in
 * `cloudwatch-metrics.json` for the api service (`RequestProcessed`,
 * `RequestFailed`, `ProcessingDuration`) on one CloudWatch dashboard.
 */
export class MetricsDashboard extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: MetricsDashboardProps) {
    super(scope, id);

    const { namespace } = props;

    const requestProcessed = new cloudwatch.Metric({
      namespace,
      metricName: 'RequestProcessed',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });
    const requestFailed = new cloudwatch.Metric({
      namespace,
      metricName: 'RequestFailed',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });
    const processingDuration = new cloudwatch.Metric({
      namespace,
      metricName: 'ProcessingDuration',
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
    });

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: props.dashboardName,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'API requests processed vs failed',
            left: [requestProcessed],
            right: [requestFailed],
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: 'API processing duration (avg ms)',
            left: [processingDuration],
            width: 12,
          }),
        ],
      ],
    });
  }
}
