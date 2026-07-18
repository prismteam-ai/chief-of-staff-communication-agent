import { createHash } from 'node:crypto';

import { initTRPC, TRPCError } from '@trpc/server';
import { createObservability } from '@chief/observability';

import type { ApiContext } from './context.js';

const fallbackObservability = createObservability('chief-api');

type StableErrorClass =
  | 'TRPCError'
  | 'TypeError'
  | 'RangeError'
  | 'SyntaxError'
  | 'Error'
  | 'UnknownError';

function stableErrorClass(value: unknown): StableErrorClass {
  if (value instanceof TRPCError) return 'TRPCError';
  if (value instanceof TypeError) return 'TypeError';
  if (value instanceof RangeError) return 'RangeError';
  if (value instanceof SyntaxError) return 'SyntaxError';
  if (value instanceof Error) return 'Error';
  return 'UnknownError';
}

function stableCauseCategory(error: unknown): StableErrorClass | 'none' {
  if (!(error instanceof Error) || error.cause === undefined) return 'none';
  return stableErrorClass(error.cause);
}

const canonicalPublicProcedurePaths = new Set([
  'agent.createDraft',
  'agent.recommend',
  'agent.requestContext',
  'agent.reviseDraft',
  'approvals.approve',
  'approvals.prepare',
  'approvals.prepareAsana',
  'approvals.prepareDraft',
  'approvals.status',
  'communications.get',
  'communications.list',
  'communications.thread',
  'connectors.status',
  'dashboard.metrics',
  'dashboard.sla',
  'execution.status',
  'knowledge.search',
  'system.health',
  'work.relatedAsana',
]);

function safeProcedurePath(path: string | undefined): string {
  if (path === undefined) return 'context';
  return canonicalPublicProcedurePaths.has(path) ? path : 'unknown_procedure';
}

function sanitizedOriginalFrames(value: unknown): readonly string[] {
  if (!(value instanceof Error) || typeof value.stack !== 'string') return [];
  return Object.freeze(
    value.stack
      .split('\n')
      .slice(1)
      .flatMap((line) => {
        const match = /(?:\(|\bat\s+)([^()\r\n]+):(\d+):(\d+)\)?\s*$/u.exec(
          line,
        );
        if (match === null) return [];
        const location = (match[1] as string).replaceAll('\\', '/');
        const stableFile = location.startsWith('node:')
          ? location
          : (location.split('/').at(-1) ?? 'unknown');
        if (!/^(?:node:[a-z0-9_./-]+|[A-Za-z0-9_.-]{1,128})$/u.test(stableFile))
          return [];
        return [`at ${stableFile}:${match[2]}:${match[3]}`];
      })
      .slice(0, 12),
  );
}

export function buildPublicTrpcServerDiagnostic(input: {
  readonly error: unknown;
  readonly errorCode: string;
  readonly procedurePath?: string;
  readonly requestId?: string;
}) {
  const errorClass = stableErrorClass(input.error);
  const causeCategory = stableCauseCategory(input.error);
  const procedurePath = safeProcedurePath(input.procedurePath);
  const requestId =
    input.requestId !== undefined &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.requestId)
      ? input.requestId
      : 'context-unavailable';
  const errorFrames = sanitizedOriginalFrames(input.error);
  const causeFrames =
    input.error instanceof Error
      ? sanitizedOriginalFrames(input.error.cause)
      : Object.freeze([]);
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        errorCode: input.errorCode,
        errorClass,
        causeCategory,
        procedurePath,
        errorFrames: errorFrames.slice(0, 3),
        causeFrames: causeFrames.slice(0, 3),
      }),
    )
    .digest('hex');
  return Object.freeze({
    requestId,
    fingerprint,
    errorClass,
    causeCategory,
    procedurePath,
    serverStack:
      errorFrames.length === 0
        ? 'server-stack-unavailable'
        : errorFrames.join('\n'),
    causeStack:
      causeFrames.length === 0
        ? 'cause-stack-unavailable'
        : causeFrames.join('\n'),
  });
}

export function publicTrpcErrorMessage(code: string): string {
  switch (code) {
    case 'BAD_REQUEST':
    case 'PARSE_ERROR':
      return 'The request could not be processed.';
    case 'UNAUTHORIZED':
      return 'Authentication is required.';
    case 'FORBIDDEN':
      return 'The request is not permitted.';
    case 'NOT_FOUND':
      return 'The requested resource was not found.';
    case 'CONFLICT':
      return 'The request conflicts with current state.';
    case 'TOO_MANY_REQUESTS':
      return 'Too many requests.';
    default:
      return 'The request failed safely.';
  }
}

const t = initTRPC.context<ApiContext>().create({
  errorFormatter({ ctx, error, path, shape }) {
    const observability = ctx?.observability ?? fallbackObservability;
    const diagnostic = buildPublicTrpcServerDiagnostic({
      error,
      errorCode: error.code,
      procedurePath: path,
      requestId: ctx?.lambdaContext.awsRequestId,
    });
    observability.logger.error('Public tRPC request failed', {
      errorCode: error.code,
      ...diagnostic,
    });
    return {
      code: shape.code,
      message: publicTrpcErrorMessage(shape.data.code),
      data: {
        code: shape.data.code,
        httpStatus: shape.data.httpStatus,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
