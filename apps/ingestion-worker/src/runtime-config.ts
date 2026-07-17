import type { IngestionSource } from './types.js';

const PRODUCTION_SOURCES = Object.freeze([
  'gmail',
  'microsoft_graph',
  'imap',
  'twilio_sms',
  'twilio_whatsapp',
  'x',
  'linkedin_archive',
  'asana',
] as const satisfies readonly IngestionSource[]);

export type ProductionIngestionSource = (typeof PRODUCTION_SOURCES)[number];

export interface ConnectorBinding {
  readonly source: ProductionIngestionSource;
  readonly connectorId: string;
  readonly descriptorVersion: string;
}

export interface ProductionIngestionConfig {
  readonly runtimeMode: 'production';
  readonly coreTableName: string;
  readonly connectorRuntimeTableName: string;
  readonly retrievalTableName: string;
  readonly snapshotBucketName: string;
  readonly digestKeySecretArn: string;
  readonly productDataKeyArn: string;
  readonly threadLookupIndexName: string;
  readonly identityLookupIndexName: string;
  readonly asanaTopicLookupIndexName: string;
  readonly connectorBindings: ReadonlyMap<
    ProductionIngestionSource,
    ConnectorBinding
  >;
}

export class IngestionConfigurationError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'IngestionConfigurationError';
  }
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0)
    throw new IngestionConfigurationError(`MISSING_${name}`);
  if (value.length > 2_048)
    throw new IngestionConfigurationError(`INVALID_${name}`);
  return value;
}

function isProductionSource(value: string): value is ProductionIngestionSource {
  return (PRODUCTION_SOURCES as readonly string[]).includes(value);
}

export function parseConnectorBindings(
  serialized: string,
): ReadonlyMap<ProductionIngestionSource, ConnectorBinding> {
  const bindings = new Map<ProductionIngestionSource, ConnectorBinding>();
  for (const rawEntry of serialized.split(',')) {
    const match =
      /^(?<source>[a-z_]+)=(?<connectorId>[A-Za-z0-9][A-Za-z0-9_-]{0,99})@(?<version>[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u.exec(
        rawEntry,
      );
    const source = match?.groups?.source;
    if (
      source === undefined ||
      !isProductionSource(source) ||
      match?.groups?.connectorId === undefined ||
      match.groups.version === undefined ||
      bindings.has(source)
    ) {
      throw new IngestionConfigurationError(
        'INVALID_INGESTION_CONNECTOR_BINDINGS',
      );
    }
    bindings.set(
      source,
      Object.freeze({
        source,
        connectorId: match.groups.connectorId,
        descriptorVersion: match.groups.version,
      }),
    );
  }
  if (PRODUCTION_SOURCES.some((source) => !bindings.has(source)))
    throw new IngestionConfigurationError(
      'INCOMPLETE_INGESTION_CONNECTOR_BINDINGS',
    );
  return bindings;
}

export function loadProductionIngestionConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ProductionIngestionConfig {
  if (required(environment, 'INGESTION_RUNTIME_MODE') !== 'production')
    throw new IngestionConfigurationError('INVALID_INGESTION_RUNTIME_MODE');
  return Object.freeze({
    runtimeMode: 'production',
    coreTableName: required(environment, 'CORE_TABLE_NAME'),
    connectorRuntimeTableName: required(
      environment,
      'CONNECTOR_RUNTIME_TABLE_NAME',
    ),
    retrievalTableName: required(environment, 'RETRIEVAL_TABLE_NAME'),
    snapshotBucketName: required(environment, 'SNAPSHOT_BUCKET_NAME'),
    digestKeySecretArn: required(environment, 'DIGEST_KEY_SECRET_ARN'),
    productDataKeyArn: required(environment, 'PRODUCT_DATA_KEY_ARN'),
    threadLookupIndexName: required(
      environment,
      'INGESTION_THREAD_LOOKUP_INDEX_NAME',
    ),
    identityLookupIndexName: required(
      environment,
      'INGESTION_IDENTITY_LOOKUP_INDEX_NAME',
    ),
    asanaTopicLookupIndexName: required(
      environment,
      'INGESTION_ASANA_TOPIC_LOOKUP_INDEX_NAME',
    ),
    connectorBindings: parseConnectorBindings(
      required(environment, 'INGESTION_CONNECTOR_BINDINGS'),
    ),
  });
}

export const productionIngestionSources = PRODUCTION_SOURCES;
