import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withLilypadTimeout } from './LilypadTimeout';

class TestTimeoutError extends Error {}

describe('withLilypadTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should reject with the created error and abort the signal with it', async () => {
    let received: AbortSignal | undefined;
    const result = withLilypadTimeout(
      (signal) => {
        received = signal;
        return new Promise<never>(() => {});
      },
      100,
      () => new TestTimeoutError('timed out')
    );
    // eslint-disable-next-line vitest/valid-expect -- awaited once the fake timers have advanced
    const assertion = expect(result).rejects.toBeInstanceOf(TestTimeoutError);

    await vi.advanceTimersByTimeAsync(100);

    await assertion;
    expect(received?.aborted).toBe(true);
    expect(await result.catch((error: unknown) => error)).toBe(received?.reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should reject with the timeout error even if the operation rejects from its abort listener', async () => {
    const result = withLilypadTimeout(
      (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted by the operation'));
          });
        }),
      100,
      () => new TestTimeoutError('timed out')
    );
    // eslint-disable-next-line vitest/valid-expect -- awaited once the fake timers have advanced
    const assertion = expect(result).rejects.toBeInstanceOf(TestTimeoutError);

    await vi.advanceTimersByTimeAsync(100);

    await assertion;
  });

  it('should resolve an operation that resolves at once, without aborting its signal', async () => {
    let received: AbortSignal | undefined;

    await expect(
      withLilypadTimeout(
        (signal) => {
          received = signal;
          return Promise.resolve(1);
        },
        100,
        () => new TestTimeoutError('timed out')
      )
    ).resolves.toBe(1);
    expect(received?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should pass on the rejection of the operation and clear the timer', async () => {
    await expect(
      withLilypadTimeout(
        () => Promise.reject(new Error('failed')),
        100,
        () => new TestTimeoutError('timed out')
      )
    ).rejects.toThrow('failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should reject, not throw, when the operation throws synchronously, and clear the timer', async () => {
    let result: Promise<unknown> | undefined;

    expect(() => {
      result = withLilypadTimeout(
        () => {
          throw new Error('sync failure');
        },
        100,
        () => new TestTimeoutError('timed out')
      );
    }).not.toThrow();
    await expect(result).rejects.toThrow('sync failure');
    expect(vi.getTimerCount()).toBe(0);
  });
});
