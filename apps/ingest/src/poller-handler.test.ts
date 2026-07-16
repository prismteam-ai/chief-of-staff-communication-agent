import { describe, expect, it, vi } from 'vitest';
import { sendBatchWithRetry, type SendMessageBatchFn } from './poller-handler.js';

const noopLog = { warn: vi.fn(), error: vi.fn() };

describe('sendBatchWithRetry', () => {
  it('does not retry when the batch fully succeeds', async () => {
    const send: SendMessageBatchFn = vi.fn().mockResolvedValue({ Failed: [], Successful: [] });
    const entries = [{ Id: '0', MessageBody: '{}' }];

    await sendBatchWithRetry(entries, send, noopLog);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries only the failed entries once and succeeds without throwing', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Failed: [{ Id: '1', SenderFault: false, Code: 'ServiceUnavailable' }],
        Successful: [{ Id: '0' }],
      })
      .mockResolvedValueOnce({ Failed: [], Successful: [{ Id: '1' }] }) as unknown as SendMessageBatchFn;
    const entries = [
      { Id: '0', MessageBody: '{"a":1}' },
      { Id: '1', MessageBody: '{"a":2}' },
    ];

    await expect(sendBatchWithRetry(entries, send, noopLog)).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(2);
    // The retry call carries only the failed entry, not the whole batch.
    expect((send as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toEqual([{ Id: '1', MessageBody: '{"a":2}' }]);
    expect(noopLog.error).not.toHaveBeenCalled();
  });

  it('throws when an entry is still failed after the retry', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Failed: [{ Id: '1', SenderFault: false, Code: 'ServiceUnavailable' }],
        Successful: [{ Id: '0' }],
      })
      .mockResolvedValueOnce({
        Failed: [{ Id: '1', SenderFault: false, Code: 'ServiceUnavailable' }],
        Successful: [],
      }) as unknown as SendMessageBatchFn;
    const entries = [
      { Id: '0', MessageBody: '{"a":1}' },
      { Id: '1', MessageBody: '{"a":2}' },
    ];

    await expect(sendBatchWithRetry(entries, send, noopLog)).rejects.toThrow(/still failed after one retry/);
    expect(send).toHaveBeenCalledTimes(2);
    expect(noopLog.error).toHaveBeenCalledTimes(1);
  });
});
