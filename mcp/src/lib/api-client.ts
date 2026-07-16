/**
 * Minimal tRPC HTTP client for the MCP server (Task 11, design.md §8). Same dependency-light
 * plain-`fetch` wrapper `apps/web/src/lib/trpc-client.ts` uses against the same Lambda tRPC HTTP
 * contract (GET `?input=<json>` for queries, POST JSON body for mutations,
 * `{result:{data:...}}`/`{error:{message}}` envelopes) — the MCP server has no AWS credentials and
 * never talks to DynamoDB/OpenSearch directly, only this hosted API over HTTPS (brief constraint 2).
 *
 * The one addition over the dashboard's client: every call carries
 * `Authorization: Bearer <COS_API_TOKEN>` instead of a caller-supplied `userId` — the hosted
 * `routers/mcp.ts` resolves `userId` FROM this token server-side (brief constraint 3: "NEVER trust
 * a client-supplied userId when a token is present"). A 401 here means the token is missing,
 * unknown, or revoked; the tool handlers surface that as a clear MCP tool error, never retried
 * silently.
 */

export class McpApiError extends Error {
  constructor(
    message: string,
    public readonly procedure: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'McpApiError';
  }
}

interface TrpcSuccessEnvelope<T> {
  result: { data: T };
}
interface TrpcErrorEnvelope {
  error: { message: string; code?: string };
}

function isErrorEnvelope(body: unknown): body is TrpcErrorEnvelope {
  return typeof body === 'object' && body !== null && 'error' in body;
}

export interface ApiClientConfig {
  /** The deployed API's base URL, e.g. `https://klxrwe0sa3.execute-api.us-east-2.amazonaws.com` —
   * `COS_API_URL`. */
  baseUrl: string;
  /** The per-user token minted by the dashboard's `issueMcpToken` — `COS_API_TOKEN`. */
  token: string;
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export function createMcpApiClient(config: ApiClientConfig) {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const fetchImpl = config.fetchImpl ?? fetch;
  const authHeader = `Bearer ${config.token}`;

  async function query<T>(procedure: string, input: unknown): Promise<T> {
    const url = `${baseUrl}/mcp.${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: authHeader },
    });
    const body: unknown = await response.json();
    if (!response.ok || isErrorEnvelope(body)) {
      const message = isErrorEnvelope(body) ? body.error.message : `HTTP ${response.status}`;
      throw new McpApiError(message, procedure, response.status);
    }
    return (body as TrpcSuccessEnvelope<T>).result.data;
  }

  async function mutate<T>(procedure: string, input: unknown): Promise<T> {
    const url = `${baseUrl}/mcp.${procedure}`;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify(input),
    });
    const body: unknown = await response.json();
    if (!response.ok || isErrorEnvelope(body)) {
      const message = isErrorEnvelope(body) ? body.error.message : `HTTP ${response.status}`;
      throw new McpApiError(message, procedure, response.status);
    }
    return (body as TrpcSuccessEnvelope<T>).result.data;
  }

  return { query, mutate };
}

export type McpApiClient = ReturnType<typeof createMcpApiClient>;
