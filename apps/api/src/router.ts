import { createHealthResponse } from '@chief/contracts';

import { publicProcedure, router } from './trpc.js';

export const systemRouter = router({
  health: publicProcedure.query(({ ctx }) => {
    ctx.observability.logger.info('Foundation health requested');
    return createHealthResponse('chief-api');
  }),
});

export const appRouter = router({
  system: systemRouter,
});

export type AppRouter = typeof appRouter;
