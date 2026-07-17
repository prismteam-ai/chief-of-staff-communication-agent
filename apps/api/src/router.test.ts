import { describe, expect, it } from 'vitest';

import { createObservability } from '@chief/observability';

import { appRouter } from './router.js';

describe('system router', () => {
  it('returns a typed foundation health response', async () => {
    const caller = appRouter.createCaller({
      event: {} as never,
      lambdaContext: {} as never,
      observability: createObservability('chief-api-test'),
    });

    const result = await caller.system.health();

    expect(result).toMatchObject({
      service: 'chief-api',
      status: 'ok',
      foundationOnly: true,
    });
  });
});
