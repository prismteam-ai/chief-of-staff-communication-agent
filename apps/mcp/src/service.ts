import type { McpToolName } from '@chief/contracts';
import { mcpToolSchemas } from '@chief/contracts';

export const MCP_MAX_BODY_BYTES = 64 * 1024;
export const MCP_DEFAULT_TOOL_TIMEOUT_MS = 5_000;

export interface McpRequestScope {
  readonly kind: 'public_fixture';
  readonly tenantId: string;
  readonly userId: string;
  readonly authorizationEpoch: number;
}

export interface McpToolService {
  call(toolName: McpToolName, input: unknown, scope: McpRequestScope): unknown;
}

export class McpToolError extends Error {
  public constructor(
    public readonly code:
      | 'NOT_FOUND'
      | 'STALE_REVISION'
      | 'INVALID_CURSOR'
      | 'SCOPE_VIOLATION'
      | 'TOOL_TIMEOUT'
      | 'INTERNAL_ERROR',
  ) {
    super(code);
    this.name = 'McpToolError';
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new McpToolError('TOOL_TIMEOUT'));
    }, milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertTenantScope(value: unknown, expectedTenantId: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertTenantScope(item, expectedTenantId);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'tenantId' && item !== expectedTenantId) {
      throw new McpToolError('SCOPE_VIOLATION');
    }
    assertTenantScope(item, expectedTenantId);
  }
}

export class McpToolRuntime {
  public constructor(
    private readonly service: McpToolService,
    private readonly scope: McpRequestScope,
    private readonly timeoutMs = MCP_DEFAULT_TOOL_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('MCP tool timeout must be a positive integer.');
    }
  }

  public async execute(
    toolName: McpToolName,
    rawInput: unknown,
  ): Promise<Record<string, unknown>> {
    const schemas = mcpToolSchemas[toolName];
    const input = schemas.input.parse(rawInput);
    const result = await withTimeout(
      Promise.resolve(this.service.call(toolName, input, this.scope)),
      this.timeoutMs,
    );
    const parsedResult = schemas.result.parse(result);
    if (
      parsedResult === null ||
      typeof parsedResult !== 'object' ||
      Array.isArray(parsedResult)
    ) {
      throw new McpToolError('INTERNAL_ERROR');
    }
    assertTenantScope(parsedResult, this.scope.tenantId);
    return parsedResult;
  }
}
