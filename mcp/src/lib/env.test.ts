import { describe, expect, it } from 'vitest';
import { loadMcpServerEnv, McpServerConfigError } from './env.js';

describe('loadMcpServerEnv', () => {
  it('loads COS_API_URL and COS_API_TOKEN', () => {
    const env = loadMcpServerEnv({
      COS_API_URL: 'https://klxrwe0sa3.execute-api.us-east-2.amazonaws.com',
      COS_API_TOKEN: 'cos_mcp_abc123',
    });

    expect(env.apiUrl).toBe('https://klxrwe0sa3.execute-api.us-east-2.amazonaws.com');
    expect(env.apiToken).toBe('cos_mcp_abc123');
  });

  it('throws a clear McpServerConfigError when COS_API_URL is missing', () => {
    expect(() => loadMcpServerEnv({ COS_API_TOKEN: 'x' })).toThrow(McpServerConfigError);
  });

  it('throws a clear McpServerConfigError when COS_API_TOKEN is missing', () => {
    expect(() => loadMcpServerEnv({ COS_API_URL: 'https://example.com' })).toThrow(
      McpServerConfigError,
    );
  });
});
