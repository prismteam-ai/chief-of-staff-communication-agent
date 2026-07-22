const exportPrefix = 'chief-communications:runtime';

export const runtimeExportNames = Object.freeze({
  connectorRuntimeTableArn: `${exportPrefix}:connector-runtime-table-arn`,
  connectorRuntimeTableName: `${exportPrefix}:connector-runtime-table-name`,
  coreTableArn: `${exportPrefix}:core-table-arn`,
  coreTableName: `${exportPrefix}:core-table-name`,
  dataKeyArn: `${exportPrefix}:data-key-arn`,
  digestKeySecretArn: `${exportPrefix}:digest-key-secret-arn`,
  ingestionQueueArn: `${exportPrefix}:ingestion-queue-arn`,
  ingestionQueueUrl: `${exportPrefix}:ingestion-queue-url`,
  outboxQueueArn: `${exportPrefix}:outbox-queue-arn`,
  outboxQueueUrl: `${exportPrefix}:outbox-queue-url`,
  productEventBusArn: `${exportPrefix}:event-bus-arn`,
  productEventBusName: `${exportPrefix}:event-bus-name`,
  retrievalTableArn: `${exportPrefix}:retrieval-table-arn`,
  retrievalTableName: `${exportPrefix}:retrieval-table-name`,
  snapshotBucketArn: `${exportPrefix}:snapshot-bucket-arn`,
  snapshotBucketName: `${exportPrefix}:snapshot-bucket-name`,
} as const);
