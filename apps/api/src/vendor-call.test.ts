import { beforeEach, describe, expect, it, vi } from 'vitest';
import { vendorCall } from './vendor-call.js';

describe('vendorCall', () => {
  beforeEach(() => vi.useRealTimers());

  it('retries a transient failure and returns the later result', async () => {
    vi.useFakeTimers();
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce('ok');
    const result = vendorCall('retry-test', run, { timeoutMs: 1_000, retries: 1 });
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('aborts and rejects a call that exceeds its timeout', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = vendorCall('timeout-test', async current => {
      signal = current;
      return new Promise<string>(() => undefined);
    }, { timeoutMs: 50, retries: 0 });
    const rejection = expect(result).rejects.toThrow('timeout-test timed out');
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it('opens the circuit after five exhausted calls', async () => {
    const run = vi.fn(async () => { throw new Error('down'); });
    for (let index = 0; index < 5; index++) {
      await expect(vendorCall('circuit-test', run, { timeoutMs: 1_000, retries: 0 })).rejects.toThrow('down');
    }
    await expect(vendorCall('circuit-test', run, { timeoutMs: 1_000, retries: 0 })).rejects.toThrow('circuit breaker is open');
    expect(run).toHaveBeenCalledTimes(5);
  });
});
