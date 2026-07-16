import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface DlqAlarmProps {
  readonly dlq: sqs.IQueue;
  readonly alarmName: string;
  readonly topicName: string;
}

/**
 * The full DLQ alarm rule (design.md §12, brief constraint 3): "exactly one stateful alarm per
 * DLQ (`ApproximateNumberOfMessagesVisible`, Maximum, >0, 1/1 evaluation, `treatMissingData:
 * NOT_BREACHING`) with ALARM and OK actions on one SNS topic fanning out to email/chat/PagerDuty
 * (PagerDuty subscription production-only; never per-message alerts)". No subscriptions are
 * wired here — PagerDuty is gated to the production flag and lands at Task 13; this construct
 * only stands up the topic and the alarm-to-topic wiring so a later task adds subscriptions
 * without touching the alarm definition itself.
 */
export class DlqAlarm extends Construct {
  public readonly topic: sns.Topic;
  public readonly alarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: DlqAlarmProps) {
    super(scope, id);

    this.topic = new sns.Topic(this, 'Topic', { topicName: props.topicName });

    const metric = props.dlq.metricApproximateNumberOfMessagesVisible({
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
    });

    this.alarm = new cloudwatch.Alarm(this, 'Alarm', {
      alarmName: props.alarmName,
      metric,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.alarm.addAlarmAction(new cloudwatchActions.SnsAction(this.topic));
    this.alarm.addOkAction(new cloudwatchActions.SnsAction(this.topic));
  }
}
