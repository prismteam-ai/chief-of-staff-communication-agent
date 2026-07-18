import { createHash } from 'node:crypto';

import type { EffectExecutionArtifact } from '@chief/contracts/approval';
import type { ConnectorAccountRef } from '@chief/contracts/connectors';

import type {
  AsanaCredentialSource,
  AsanaEffectPayload,
  AsanaReconciliationResult,
  AsanaRequest,
  AsanaResponse,
  AsanaTransport,
  AsanaTransportEvidence,
  AsanaTransportEvidenceSink,
} from './types.js';

export const ASANA_API_ORIGIN = 'https://app.asana.com' as const;
export const ASANA_API_PREFIX = '/api/1.0' as const;
export const ASANA_REQUEST_DEADLINE_MILLISECONDS = 10_000;
export const ASANA_MAX_RESPONSE_BYTES = 1_048_576;
export const ASANA_MAX_REQUEST_BYTES = 65_536;
export const ASANA_RECONCILIATION_MAX_PAGES = 2;
export const ASANA_RECONCILIATION_MAX_ITEMS = 100;
export const ASANA_ALL_TASK_HISTORY_FLOOR = '1970-01-01T00:00:00.000Z';
const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'authorization',
  'bearer',
  'client_secret',
  'password',
  'pat',
  'secret',
  'token',
]);

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type AsanaTransportIssueCode =
  | 'ASANA_TRANSPORT_CONFIGURATION_INVALID'
  | 'ASANA_TRANSPORT_REQUEST_INVALID'
  | 'ASANA_TRANSPORT_REQUEST_TOO_LARGE'
  | 'ASANA_TRANSPORT_CREDENTIAL_INVALID'
  | 'ASANA_TRANSPORT_DEADLINE_EXCEEDED'
  | 'ASANA_TRANSPORT_FAILED'
  | 'ASANA_TRANSPORT_REDIRECT_REJECTED'
  | 'ASANA_TRANSPORT_HOST_REJECTED'
  | 'ASANA_TRANSPORT_CONTENT_TYPE_REJECTED'
  | 'ASANA_TRANSPORT_RESPONSE_TOO_LARGE'
  | 'ASANA_TRANSPORT_RESPONSE_INVALID';

export class AsanaTransportError extends Error {
  public constructor(
    public readonly code: AsanaTransportIssueCode,
    public readonly status?: number,
    public readonly requestId?: string,
  ) {
    super(code);
    this.name = 'AsanaTransportError';
  }
}

export interface AsanaRestTransportOptions {
  readonly credentials: AsanaCredentialSource;
  readonly fetch?: FetchLike;
  readonly evidence?: AsanaTransportEvidenceSink;
  readonly deadlineMilliseconds?: number;
  readonly maxResponseBytes?: number;
  readonly maxRequestBytes?: number;
}

function header(response: Response, name: string): string | undefined {
  const value = response.headers.get(name);
  return value === null || value.length === 0 ? undefined : value;
}

function safeRequestId(
  value: string | undefined,
  credential?: string,
): string | undefined {
  return value !== undefined &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) &&
    (credential === undefined ||
      (!value.includes(credential) &&
        !value.includes(encodeURIComponent(credential))))
    ? value
    : undefined;
}

function requestId(
  response: Response,
  credential?: string,
): string | undefined {
  return safeRequestId(
    header(response, 'x-request-id') ?? header(response, 'x-asana-request-id'),
    credential,
  );
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = header(response, 'retry-after');
  if (value === undefined || !/^[0-9]+$/u.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0
    ? Math.min(seconds, 86_400)
    : undefined;
}

function validatePath(path: string): string {
  if (
    !path.startsWith('/') ||
    path.length > 2_048 ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#') ||
    [...path].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    }) ||
    /(?:^|\/)\.\.?($|\/)/u.test(path) ||
    /%(?:25|2e)/iu.test(path) ||
    /%(?:2f|5c)/iu.test(path)
  ) {
    throw new AsanaTransportError('ASANA_TRANSPORT_REQUEST_INVALID');
  }
  return path;
}

function buildUrl(request: AsanaRequest): URL {
  const path = validatePath(request.path);
  const url = new URL(`${ASANA_API_PREFIX}${path}`, ASANA_API_ORIGIN);
  if (
    url.protocol !== 'https:' ||
    url.origin !== ASANA_API_ORIGIN ||
    !url.pathname.startsWith(`${ASANA_API_PREFIX}/`)
  ) {
    throw new AsanaTransportError('ASANA_TRANSPORT_HOST_REJECTED');
  }
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (
      !/^[A-Za-z0-9_.]+$/u.test(key) ||
      SENSITIVE_QUERY_KEYS.has(key.toLowerCase()) ||
      value.length > 4_096
    ) {
      throw new AsanaTransportError('ASANA_TRANSPORT_REQUEST_INVALID');
    }
    url.searchParams.set(key, value);
  }
  return url;
}

function stableOperationId(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requestHeaders(request: AsanaRequest, token: string): Headers {
  if (
    token.length < 16 ||
    token.length > 4_096 ||
    [...token].some((character) => {
      const code = character.charCodeAt(0);
      return code < 33 || code > 126;
    })
  ) {
    throw new AsanaTransportError('ASANA_TRANSPORT_CREDENTIAL_INVALID');
  }
  const headers = new Headers({
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  });
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (name.toLowerCase() !== 'if-unmodified-since' || /[\r\n]/u.test(value)) {
      throw new AsanaTransportError('ASANA_TRANSPORT_REQUEST_INVALID');
    }
    if (value.length > 0) headers.set('if-unmodified-since', value);
  }
  if (request.operationId !== undefined) {
    headers.set('x-client-request-id', stableOperationId(request.operationId));
  }
  if (request.body !== undefined)
    headers.set('content-type', 'application/json');
  return headers;
}

function encodedBody(
  request: AsanaRequest,
  maxRequestBytes: number,
): string | undefined {
  if (request.body === undefined) return undefined;
  let body: string;
  try {
    body = JSON.stringify(request.body);
  } catch {
    throw new AsanaTransportError('ASANA_TRANSPORT_REQUEST_INVALID');
  }
  if (Buffer.byteLength(body, 'utf8') > maxRequestBytes) {
    throw new AsanaTransportError('ASANA_TRANSPORT_REQUEST_TOO_LARGE');
  }
  return body;
}

async function boundedJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  credential: string,
): Promise<unknown> {
  assertResponseActive(signal, response, credential);
  const contentType = header(response, 'content-type');
  if (
    contentType === undefined ||
    !/^application\/json(?:\s*;|$)/iu.test(contentType)
  ) {
    throw new AsanaTransportError(
      'ASANA_TRANSPORT_CONTENT_TYPE_REJECTED',
      response.status,
      requestId(response, credential),
    );
  }
  const declaredLength = header(response, 'content-length');
  if (
    declaredLength !== undefined &&
    /^[0-9]+$/u.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    throw new AsanaTransportError(
      'ASANA_TRANSPORT_RESPONSE_TOO_LARGE',
      response.status,
      requestId(response, credential),
    );
  }
  if (response.body === null) {
    throw new AsanaTransportError(
      'ASANA_TRANSPORT_RESPONSE_INVALID',
      response.status,
      requestId(response, credential),
    );
  }
  const reader = response.body.getReader();
  const abortReader = () => cancelReader(reader);
  signal.addEventListener('abort', abortReader, { once: true });
  try {
    assertResponseActive(signal, response, credential, reader);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        assertResponseActive(signal, response, credential, reader);
        const next = (await reader.read()) as {
          readonly done: boolean;
          readonly value?: Uint8Array;
        };
        assertResponseActive(signal, response, credential, reader);
        if (next.done) break;
        if (next.value === undefined) {
          throw new AsanaTransportError(
            'ASANA_TRANSPORT_RESPONSE_INVALID',
            response.status,
            requestId(response, credential),
          );
        }
        size += next.value.byteLength;
        if (size > maxBytes) {
          cancelReader(reader);
          throw new AsanaTransportError(
            'ASANA_TRANSPORT_RESPONSE_TOO_LARGE',
            response.status,
            requestId(response, credential),
          );
        }
        chunks.push(next.value);
      }
    } catch (error) {
      if (error instanceof AsanaTransportError) throw error;
      throw new AsanaTransportError(
        'ASANA_TRANSPORT_RESPONSE_INVALID',
        response.status,
        requestId(response, credential),
      );
    }
    assertResponseActive(signal, response, credential, reader);
    try {
      const parsed = JSON.parse(
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
          'utf8',
        ),
      ) as unknown;
      assertResponseActive(signal, response, credential, reader);
      return parsed;
    } catch {
      throw new AsanaTransportError(
        'ASANA_TRANSPORT_RESPONSE_INVALID',
        response.status,
        requestId(response, credential),
      );
    }
  } finally {
    signal.removeEventListener('abort', abortReader);
  }
}

function cancelReader(reader: { cancel(): Promise<unknown> }): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best effort. The public error remains content-free.
  }
}

function assertResponseActive(
  signal: AbortSignal,
  response: Response,
  credential: string,
  reader?: { cancel(): Promise<unknown> },
): void {
  if (!signal.aborted) return;
  if (reader !== undefined) cancelReader(reader);
  throw new AsanaTransportError(
    'ASANA_TRANSPORT_DEADLINE_EXCEEDED',
    response.status,
    requestId(response, credential),
  );
}

function recordEvidence(
  sink: AsanaTransportEvidenceSink | undefined,
  response: Response,
  method: AsanaRequest['method'],
  credential: string,
): void {
  const evidence: AsanaTransportEvidence = {
    method,
    status: response.status,
    ...(requestId(response, credential) === undefined
      ? {}
      : { requestId: requestId(response, credential) }),
    ...(response.status !== 429 || retryAfterSeconds(response) === undefined
      ? {}
      : { retryAfterSeconds: retryAfterSeconds(response) }),
  };
  sink?.record(Object.freeze(evidence));
}

function responseHeaders(
  response: Response,
  credential: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(requestId(response, credential) === undefined
      ? {}
      : { 'x-request-id': requestId(response, credential)! }),
    ...(retryAfterSeconds(response) === undefined
      ? {}
      : { 'retry-after': String(retryAfterSeconds(response)) }),
  });
}

function createReconciliationPage(response: AsanaResponse):
  | Readonly<{
      tasks: readonly Readonly<{ gid: string; name: string }>[];
      nextOffset?: string;
    }>
  | undefined {
  if (
    response.body === null ||
    typeof response.body !== 'object' ||
    Array.isArray(response.body)
  ) {
    return undefined;
  }
  const envelope = response.body as Record<string, unknown>;
  if (!Array.isArray(envelope.data) || !Object.hasOwn(envelope, 'next_page')) {
    return undefined;
  }
  const tasks: Array<Readonly<{ gid: string; name: string }>> = [];
  for (const item of envelope.data) {
    if (
      item === null ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      typeof (item as Record<string, unknown>).gid !== 'string' ||
      !/^[0-9]{1,64}$/u.test((item as Record<string, unknown>).gid as string) ||
      typeof (item as Record<string, unknown>).name !== 'string'
    ) {
      return undefined;
    }
    tasks.push({
      gid: (item as Record<string, unknown>).gid as string,
      name: (item as Record<string, unknown>).name as string,
    });
  }
  if (envelope.next_page === null) return Object.freeze({ tasks });
  if (
    typeof envelope.next_page !== 'object' ||
    Array.isArray(envelope.next_page) ||
    typeof (envelope.next_page as Record<string, unknown>).offset !==
      'string' ||
    ((envelope.next_page as Record<string, unknown>).offset as string).length <
      1 ||
    ((envelope.next_page as Record<string, unknown>).offset as string).length >
      1_024 ||
    [
      ...((envelope.next_page as Record<string, unknown>).offset as string),
    ].some((character) => {
      const code = character.charCodeAt(0);
      return code < 33 || code > 126;
    })
  ) {
    return undefined;
  }
  return Object.freeze({
    tasks,
    nextOffset: (envelope.next_page as Record<string, unknown>)
      .offset as string,
  });
}

function fieldsMatch(
  record: Record<string, unknown>,
  payload: AsanaEffectPayload,
): boolean {
  if (payload.kind !== 'update_task') return false;
  const fields = payload.fields;
  return (
    (fields.name === undefined || record.name === fields.name) &&
    (fields.notes === undefined || record.notes === fields.notes) &&
    (fields.assignee === undefined ||
      (record.assignee !== null &&
        typeof record.assignee === 'object' &&
        (record.assignee as { readonly gid?: unknown }).gid ===
          fields.assignee)) &&
    (fields.dueOn === undefined || record.due_on === fields.dueOn) &&
    (fields.completed === undefined || record.completed === fields.completed)
  );
}

export class AsanaRestTransport implements AsanaTransport {
  readonly #credentials: AsanaCredentialSource;
  readonly #fetch: FetchLike;
  readonly #evidence?: AsanaTransportEvidenceSink;
  readonly #deadlineMilliseconds: number;
  readonly #maxResponseBytes: number;
  readonly #maxRequestBytes: number;

  public constructor(options: AsanaRestTransportOptions) {
    const deadline =
      options.deadlineMilliseconds ?? ASANA_REQUEST_DEADLINE_MILLISECONDS;
    const maxResponse = options.maxResponseBytes ?? ASANA_MAX_RESPONSE_BYTES;
    const maxRequest = options.maxRequestBytes ?? ASANA_MAX_REQUEST_BYTES;
    if (
      !Number.isSafeInteger(deadline) ||
      deadline < 1 ||
      deadline > ASANA_REQUEST_DEADLINE_MILLISECONDS ||
      !Number.isSafeInteger(maxResponse) ||
      maxResponse < 1 ||
      maxResponse > ASANA_MAX_RESPONSE_BYTES ||
      !Number.isSafeInteger(maxRequest) ||
      maxRequest < 1 ||
      maxRequest > ASANA_MAX_REQUEST_BYTES
    ) {
      throw new AsanaTransportError('ASANA_TRANSPORT_CONFIGURATION_INVALID');
    }
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#evidence = options.evidence;
    this.#deadlineMilliseconds = deadline;
    this.#maxResponseBytes = maxResponse;
    this.#maxRequestBytes = maxRequest;
  }

  public async request(request: AsanaRequest): Promise<AsanaResponse> {
    const url = buildUrl(request);
    const body = encodedBody(request, this.#maxRequestBytes);
    const controller = new AbortController();
    let timedOut = false;
    let rejectDeadline: (error: AsanaTransportError) => void = () => undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectDeadline(
        new AsanaTransportError('ASANA_TRANSPORT_DEADLINE_EXCEEDED'),
      );
    }, this.#deadlineMilliseconds);
    const abortFromCaller = () => {
      controller.abort();
      rejectDeadline(
        new AsanaTransportError('ASANA_TRANSPORT_DEADLINE_EXCEEDED'),
      );
    };
    request.signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (request.signal?.aborted === true) controller.abort();
    try {
      if (controller.signal.aborted) {
        throw new AsanaTransportError('ASANA_TRANSPORT_DEADLINE_EXCEEDED');
      }
      let credentialUseClaimed = false;
      const operation = this.#credentials.withBearerToken(
        request.account,
        async (token) => {
          if (credentialUseClaimed) {
            throw new AsanaTransportError('ASANA_TRANSPORT_CREDENTIAL_INVALID');
          }
          credentialUseClaimed = true;
          if (controller.signal.aborted) {
            throw new AsanaTransportError('ASANA_TRANSPORT_DEADLINE_EXCEEDED');
          }
          const headers = requestHeaders(request, token);
          const urlValue = url.toString();
          const encodedToken = JSON.stringify(token).slice(1, -1);
          if (
            request.path.includes(token) ||
            Object.values(request.query ?? {}).some((value) =>
              value.includes(token),
            ) ||
            urlValue.includes(token) ||
            urlValue.includes(encodeURIComponent(token)) ||
            (body !== undefined &&
              (body.includes(token) || body.includes(encodedToken))) ||
            Object.values(request.headers ?? {}).some((value) =>
              value.includes(token),
            )
          ) {
            throw new AsanaTransportError('ASANA_TRANSPORT_REQUEST_INVALID');
          }
          let response: Response;
          try {
            if (controller.signal.aborted) {
              throw new AsanaTransportError(
                'ASANA_TRANSPORT_DEADLINE_EXCEEDED',
              );
            }
            response = await this.#fetch(url, {
              method: request.method,
              headers,
              ...(body === undefined ? {} : { body }),
              redirect: 'manual',
              signal: controller.signal,
            });
          } catch {
            throw new AsanaTransportError(
              timedOut
                ? 'ASANA_TRANSPORT_DEADLINE_EXCEEDED'
                : 'ASANA_TRANSPORT_FAILED',
            );
          }
          assertResponseActive(controller.signal, response, token);
          if (response.status >= 300 && response.status < 400) {
            throw new AsanaTransportError(
              'ASANA_TRANSPORT_REDIRECT_REJECTED',
              response.status,
              requestId(response, token),
            );
          }
          if (response.url.length > 0) {
            const finalUrl = new URL(response.url);
            if (
              finalUrl.origin !== ASANA_API_ORIGIN ||
              !finalUrl.pathname.startsWith(`${ASANA_API_PREFIX}/`)
            ) {
              throw new AsanaTransportError(
                'ASANA_TRANSPORT_HOST_REJECTED',
                response.status,
                requestId(response, token),
              );
            }
          }
          const parsed = await boundedJson(
            response,
            this.#maxResponseBytes,
            controller.signal,
            token,
          );
          assertResponseActive(controller.signal, response, token);
          recordEvidence(this.#evidence, response, request.method, token);
          return Object.freeze({
            status: response.status,
            headers: responseHeaders(response, token),
            body: parsed,
          });
        },
      );
      return await Promise.race([operation, deadline]);
    } catch (error) {
      if (timedOut || request.signal?.aborted === true) {
        throw new AsanaTransportError('ASANA_TRANSPORT_DEADLINE_EXCEEDED');
      }
      if (error instanceof AsanaTransportError) throw error;
      throw new AsanaTransportError(
        timedOut
          ? 'ASANA_TRANSPORT_DEADLINE_EXCEEDED'
          : 'ASANA_TRANSPORT_CREDENTIAL_INVALID',
      );
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  public async reconcileEffect(
    account: ConnectorAccountRef,
    _artifact: EffectExecutionArtifact,
    payload: AsanaEffectPayload,
    signal?: AbortSignal,
  ): Promise<AsanaReconciliationResult> {
    if (payload.kind === 'update_task') {
      const response = await this.request({
        method: 'GET',
        path: `/tasks/${encodeURIComponent(payload.taskGid)}`,
        query: {
          opt_fields:
            'gid,name,notes,assignee.gid,due_on,completed,modified_at,workspace.gid,memberships.project.gid',
        },
        account,
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status !== 200) {
        return response.status === 404
          ? { outcome: 'proven_nonacceptance', response: { status: 404 } }
          : {
              outcome: 'unknown',
              reasonCode: 'asana_update_reconciliation_failed',
            };
      }
      const record =
        response.body !== null && typeof response.body === 'object'
          ? (response.body as { readonly data?: unknown }).data
          : undefined;
      if (
        record === null ||
        typeof record !== 'object' ||
        Array.isArray(record)
      ) {
        return {
          outcome: 'unknown',
          reasonCode: 'asana_update_reconciliation_invalid',
        };
      }
      const task = record as Record<string, unknown>;
      if (task.gid !== payload.taskGid) {
        return {
          outcome: 'unknown',
          reasonCode: 'asana_update_reconciliation_invalid',
        };
      }
      if (fieldsMatch(task, payload)) {
        return {
          outcome: 'accepted',
          gid: payload.taskGid,
          response: { status: response.status, gid: payload.taskGid },
        };
      }
      return task.modified_at === payload.precondition.modifiedAt
        ? {
            outcome: 'proven_nonacceptance',
            response: { status: response.status, gid: payload.taskGid },
          }
        : {
            outcome: 'unknown',
            reasonCode: 'asana_update_acceptance_ambiguous',
          };
    }

    if (payload.kind !== 'create_task' || payload.projectGid === undefined) {
      return {
        outcome: 'unknown',
        reasonCode: 'asana_reconciliation_unsupported',
      };
    }
    let offset: string | undefined;
    let complete = false;
    const matches: string[] = [];
    const seenOffsets = new Set<string>();
    const seenGids = new Set<string>();
    let observed = 0;
    for (let page = 0; page < ASANA_RECONCILIATION_MAX_PAGES; page += 1) {
      const remaining = ASANA_RECONCILIATION_MAX_ITEMS - observed;
      const response = await this.request({
        method: 'GET',
        path: `/projects/${encodeURIComponent(payload.projectGid)}/tasks`,
        query: {
          opt_fields: 'gid,name',
          completed_since: ASANA_ALL_TASK_HISTORY_FLOOR,
          limit: String(Math.min(100, remaining)),
          ...(offset === undefined ? {} : { offset }),
        },
        account,
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status !== 200) {
        return {
          outcome: 'unknown',
          reasonCode: 'asana_create_reconciliation_failed',
        };
      }
      const reconciliationPage = createReconciliationPage(response);
      if (reconciliationPage === undefined) {
        return {
          outcome: 'unknown',
          reasonCode: 'asana_create_reconciliation_invalid_page',
        };
      }
      if (reconciliationPage.tasks.length > remaining) {
        return {
          outcome: 'unknown',
          reasonCode: 'asana_create_reconciliation_page_overrun',
        };
      }
      for (const task of reconciliationPage.tasks) {
        observed += 1;
        if (seenGids.has(task.gid)) {
          return {
            outcome: 'unknown',
            reasonCode: 'asana_create_reconciliation_invalid_page',
          };
        }
        seenGids.add(task.gid);
        if (task.name === payload.fields.name) {
          matches.push(task.gid);
        }
        if (observed >= ASANA_RECONCILIATION_MAX_ITEMS) break;
      }
      offset = reconciliationPage.nextOffset;
      if (offset === undefined) {
        complete = true;
        break;
      }
      if (seenOffsets.has(offset)) {
        return {
          outcome: 'unknown',
          reasonCode: 'asana_create_reconciliation_offset_cycle',
        };
      }
      seenOffsets.add(offset);
      if (observed >= ASANA_RECONCILIATION_MAX_ITEMS) break;
    }
    if (!complete) {
      return {
        outcome: 'unknown',
        reasonCode: 'asana_create_reconciliation_incomplete',
      };
    }
    if (matches.length === 1) {
      return {
        outcome: 'accepted',
        gid: matches[0]!,
        response: { status: 200, gid: matches[0] },
      };
    }
    if (matches.length > 1) {
      return {
        outcome: 'unknown',
        reasonCode: 'asana_create_reconciliation_ambiguous',
      };
    }
    return { outcome: 'proven_nonacceptance', response: { status: 200 } };
  }
}
