import { describe, expect, it, vi } from 'vitest';
import { getHealth } from './health.js';

function makeCtx() {
  return {
    logger: { info: vi.fn() },
    metrics: { addMetric: vi.fn() },
  } as unknown as Parameters<typeof getHealth>[0];
}

describe('getHealth', () => {
  it('returns ok:true with an ISO timestamp', () => {
    const ctx = makeCtx();
    const result = getHealth(ctx);

    expect(result.ok).toBe(true);
    expect(() => new Date(result.ts).toISOString()).not.toThrow();
    expect(new Date(result.ts).toISOString()).toBe(result.ts);
  });

  it('logs the health check and records the RequestProcessed metric', () => {
    const ctx = makeCtx();

    getHealth(ctx);

    expect(ctx.logger.info).toHaveBeenCalledWith('Health check requested');
    expect(ctx.metrics.addMetric).toHaveBeenCalledWith('RequestProcessed', 'Count', 1);
  });

  it('returns a fresh timestamp on every call', async () => {
    const ctx = makeCtx();
    const first = getHealth(ctx);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = getHealth(ctx);

    expect(new Date(second.ts).getTime()).toBeGreaterThanOrEqual(new Date(first.ts).getTime());
  });
});
