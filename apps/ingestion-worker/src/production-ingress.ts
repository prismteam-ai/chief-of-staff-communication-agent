import {
  accountIdSchema,
  brandIdSchema,
  sha256Schema,
  tenantIdSchema,
} from '@chief/contracts';

import type {
  ConnectorBinding,
  ProductionIngestionSource,
} from './runtime-config.js';
import type { IngestionEvent, IngestionWorkItem } from './types.js';

const MAX_SQS_BODY_BYTES = 256 * 1024;
const MAX_AUTHORITY_ACCOUNTS = 100;
const MAX_AUTHORITY_BRANDS = 100;

const ALLOWED_RUNTIME_MODES: Readonly<
  Record<ProductionIngestionSource, readonly string[]>
> = Object.freeze({
  gmail: Object.freeze(['live']),
  microsoft_graph: Object.freeze(['live']),
  imap: Object.freeze(['live']),
  twilio_sms: Object.freeze(['live_trial']),
  twilio_whatsapp: Object.freeze(['sandbox']),
  x: Object.freeze(['live']),
  linkedin_archive: Object.freeze(['manual']),
  asana: Object.freeze(['live']),
});

export interface ServerGrantAuthority {
  readonly derivation: 'server_grants';
  readonly tenantId: string;
  readonly accountIds: readonly string[];
  readonly brandIds: readonly string[];
  readonly authorizationEpoch: number;
  readonly scopeHash: string;
}

export interface ProductionIngestionRequest {
  readonly schemaVersion: '1';
  readonly authority: ServerGrantAuthority;
  readonly ingestionEvent: IngestionEvent;
}

export interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
}

export interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}

export interface SqsBatchResponse {
  readonly batchItemFailures: readonly {
    readonly itemIdentifier: string;
  }[];
}

export class ProductionIngressError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'ProductionIngressError';
  }
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ProductionIngressError('INGRESS_SCHEMA_INVALID');
  return value as Readonly<Record<string, unknown>>;
}

function stringValue(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new ProductionIngressError('INGRESS_SCHEMA_INVALID');
  return value;
}

function stringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
): readonly string[] {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((item) => typeof item !== 'string')
  )
    throw new ProductionIngressError('INGRESS_SCHEMA_INVALID');
  const strings = value as string[];
  if (new Set(strings).size !== strings.length)
    throw new ProductionIngressError('INGRESS_AUTHORITY_DUPLICATE');
  return Object.freeze([...strings]);
}

function parseAuthority(value: unknown): ServerGrantAuthority {
  const record = recordValue(value);
  if (stringValue(record, 'derivation') !== 'server_grants')
    throw new ProductionIngressError('INGRESS_AUTHORITY_REQUIRED');
  const tenantId = tenantIdSchema.parse(stringValue(record, 'tenantId'));
  const accountIds = stringArray(
    record,
    'accountIds',
    MAX_AUTHORITY_ACCOUNTS,
  ).map((accountId) => accountIdSchema.parse(accountId));
  const brandIds = stringArray(record, 'brandIds', MAX_AUTHORITY_BRANDS).map(
    (brandId) => brandIdSchema.parse(brandId),
  );
  const authorizationEpoch = record.authorizationEpoch;
  if (
    !Number.isSafeInteger(authorizationEpoch) ||
    (authorizationEpoch as number) < 1
  )
    throw new ProductionIngressError('INGRESS_AUTHORITY_EPOCH_INVALID');
  return Object.freeze({
    derivation: 'server_grants',
    tenantId,
    accountIds: Object.freeze(accountIds),
    brandIds: Object.freeze(brandIds),
    authorizationEpoch: authorizationEpoch as number,
    scopeHash: sha256Schema.parse(stringValue(record, 'scopeHash')),
  });
}

function assertAuthorityBinding(
  item: IngestionWorkItem,
  authority: ServerGrantAuthority,
): void {
  if (
    item.tenantId !== authority.tenantId ||
    !authority.accountIds.includes(item.accountId) ||
    item.authorizationEpoch !== authority.authorizationEpoch ||
    item.scopeHash !== authority.scopeHash ||
    (item.brandIds ?? []).some(
      (brandId) => !authority.brandIds.includes(brandId),
    )
  )
    throw new ProductionIngressError('INGRESS_AUTHORITY_BINDING_MISMATCH');
}

function assertConnectorBinding(
  item: IngestionWorkItem,
  bindings: ReadonlyMap<ProductionIngestionSource, ConnectorBinding>,
): void {
  if (item.source === 'demo')
    throw new ProductionIngressError('INGRESS_DEMO_FORBIDDEN');
  const binding = bindings.get(item.source);
  const allowedModes = ALLOWED_RUNTIME_MODES[item.source];
  if (
    binding === undefined ||
    item.connectorSnapshot.connectorId !== binding.connectorId ||
    item.connectorSnapshot.descriptorVersion !== binding.descriptorVersion ||
    item.connectorSnapshot.selectionState !== 'selected' ||
    !allowedModes.includes(item.connectorSnapshot.runtimeMode)
  )
    throw new ProductionIngressError('INGRESS_CONNECTOR_BINDING_MISMATCH');
}

export function parseProductionIngestionRequest(
  body: string,
  bindings: ReadonlyMap<ProductionIngestionSource, ConnectorBinding>,
): ProductionIngestionRequest {
  if (Buffer.byteLength(body, 'utf8') > MAX_SQS_BODY_BYTES)
    throw new ProductionIngressError('INGRESS_BODY_LIMIT');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new ProductionIngressError('INGRESS_JSON_INVALID');
  }
  const envelope = recordValue(parsed);
  if (
    stringValue(envelope, 'source') !== 'chief.connectors' ||
    stringValue(envelope, 'detail-type') !== 'communication.ingest.requested'
  )
    throw new ProductionIngressError('INGRESS_EVENTBRIDGE_BINDING_MISMATCH');
  const detail = recordValue(envelope.detail);
  if (stringValue(detail, 'schemaVersion') !== '1')
    throw new ProductionIngressError('INGRESS_SCHEMA_INVALID');
  const authority = parseAuthority(detail.authority);
  const ingestionEventRecord = recordValue(detail.ingestionEvent);
  const workItems = ingestionEventRecord.workItems;
  if (!Array.isArray(workItems))
    throw new ProductionIngressError('INGRESS_SCHEMA_INVALID');
  for (const candidate of workItems) {
    const item = recordValue(
      candidate as unknown,
    ) as unknown as IngestionWorkItem;
    assertAuthorityBinding(item, authority);
    assertConnectorBinding(item, bindings);
  }
  const ingestionEvent = ingestionEventRecord as unknown as IngestionEvent;
  return Object.freeze({
    schemaVersion: '1',
    authority,
    ingestionEvent,
  });
}

export function createProductionSqsHandler(
  processEvent: (event: IngestionEvent) => Promise<unknown>,
  bindings: ReadonlyMap<ProductionIngestionSource, ConnectorBinding>,
): (event: SqsEvent) => Promise<SqsBatchResponse> {
  return async (event) => {
    if (event.Records.length > 10)
      throw new ProductionIngressError('INGRESS_SQS_BATCH_INVALID');
    const failures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      try {
        if (
          typeof record.messageId !== 'string' ||
          record.messageId.length === 0 ||
          typeof record.body !== 'string'
        )
          throw new ProductionIngressError('INGRESS_SQS_RECORD_INVALID');
        const request = parseProductionIngestionRequest(record.body, bindings);
        await processEvent(request.ingestionEvent);
      } catch {
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return Object.freeze({ batchItemFailures: Object.freeze(failures) });
  };
}

export const productionRuntimeModes = ALLOWED_RUNTIME_MODES;
