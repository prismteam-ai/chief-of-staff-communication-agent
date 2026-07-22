import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalExecutionPersistence } from '@chief/approval-outbox/execution-service';
import type { OperationId } from '@chief/contracts/ids';

import {
  createEffectDisabledExecutionWorker,
  invokeFoundationWorker,
} from './handler.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('execution worker foundation', () => {
  it('keeps external effects disabled', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(invokeFoundationWorker()).toMatchObject({
      worker: 'execution-worker',
      externalEffects: 'disabled',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exposes only the credentialless effect-disabled sink in the worker factory', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const persistence = {
      claimOperation: vi.fn().mockResolvedValue({ status: 'frozen' }),
    } as unknown as ApprovalExecutionPersistence;
    const worker = createEffectDisabledExecutionWorker({
      persistence,
      now: () => '2026-07-17T12:00:00.000Z',
    });

    await expect(
      worker({
        operationId: 'operation-disabled-001' as OperationId,
        workerId: 'execution-worker-001',
        observedAt: '2026-07-17T12:00:00.000Z',
        leaseDurationMs: 30_000,
      }),
    ).resolves.toEqual({ status: 'frozen' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
