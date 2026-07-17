import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

export interface MetricsDashboardProps {
  /** Dashboard name shown in the CloudWatch console. */
  readonly dashboardName: string;
  /** CloudWatch namespace the service's Lambda(s) publish metrics under. */
  readonly namespace: string;
  /**
   * Names of the "processed" (Sum) counter metrics, graphed together on the left axis —
   * `RequestProcessed` for the api service, `MessageIngested` (optionally per-channel via
   * `dimensionsMap`) for the ingest service. Defaults to `['RequestProcessed']` so the api
   * service's existing call sites need no change.
   */
  readonly processedMetricNames?: string[];
  /** Names of the "failed" (Sum) counter metrics, graphed on the right axis. Defaults to `['RequestFailed']`. */
  readonly failedMetricNames?: string[];
  /** Name of the duration (Average) metric. Defaults to `'ProcessingDuration'`. */
  readonly durationMetricName?: string;
  /** Title prefix for the widgets, e.g. `'API'` or `'Ingest'`. Defaults to `'Service'`. */
  readonly titlePrefix?: string;
}

/**
 * Small shared construct rendering the metrics registered in `cloudwatch-metrics.json` for a
 * service on one CloudWatch dashboard: a processed-vs-failed counter graph plus a duration graph.
 * Generalized (brief constraint 3, Task 3) beyond the api service's original
 * `RequestProcessed`/`RequestFailed`/`ProcessingDuration` names so the ingest service's
 * `MessageIngested`/`MessageFailed`/`ProcessingDuration` metrics render the same way.
 */
export class MetricsDashboard extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: MetricsDashboardProps) {
    super(scope, id);

    const { namespace } = props;
    const processedNames = props.processedMetricNames ?? ['RequestProcessed'];
    const failedNames = props.failedMetricNames ?? ['RequestFailed'];
    const durationName = props.durationMetricName ?? 'ProcessingDuration';
    const titlePrefix = props.titlePrefix ?? 'Service';

    const toSumMetric = (metricName: string) =>
      new cloudwatch.Metric({
        namespace,
        metricName,
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

    const processed = processedNames.map(toSumMetric);
    const failed = failedNames.map(toSumMetric);
    const processingDuration = new cloudwatch.Metric({
      namespace,
      metricName: durationName,
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
    });

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: props.dashboardName,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: `${titlePrefix} processed vs failed`,
            left: processed,
            right: failed,
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: `${titlePrefix} processing duration (avg ms)`,
            left: [processingDuration],
            width: 12,
          }),
        ],
      ],
    });
  }
}
