import { initTRPC } from '@trpc/server';

import type { ApiContext } from './context.js';

const t = initTRPC.context<ApiContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
