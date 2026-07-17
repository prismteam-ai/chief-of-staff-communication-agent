import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeFoundationWorker } from './handler.js';

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
});
