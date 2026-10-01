import { describe, it, expect, vi } from 'vitest';
import {
  runAfterResponse,
  runInBackground,
  sharedStoreOperation,
  toTtlSeconds,
} from './LilypadPlatform';

describe('runInBackground', () => {
  it('should still run the task when the platform function throws', async () => {
    const onError = vi.fn();
    const onPlatformError = vi.fn();
    const task = vi.fn(async () => 'done');

    runInBackground(
      {
        background: () => {
          throw new Error('outside a request');
        },
      },
      task(),
      onError,
      onPlatformError
    );
    await Promise.resolve();

    expect(task).toHaveBeenCalledOnce();
    // The error of the platform is not an error of the task
    expect(onError).not.toHaveBeenCalled();
    expect(onPlatformError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'outside a request' })
    );
  });

  it('should ignore the error of the platform function without onPlatformError', async () => {
    const onError = vi.fn();

    expect(() =>
      runInBackground(
        {
          background: () => {
            throw new Error('outside a request');
          },
        },
        Promise.resolve(),
        onError
      )
    ).not.toThrow();
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
  });

  it('should pass the errors of the task to onError', async () => {
    const onError = vi.fn();

    runInBackground(undefined, Promise.reject(new Error('task failed')), onError);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'task failed' }));
  });

  it('should not let a throwing onError turn the task into an unhandled rejection', async () => {
    const onError = vi.fn(() => {
      throw new Error('handler failed');
    });

    // An unhandled rejection would fail the run
    runInBackground(undefined, Promise.reject(new Error('task failed')), onError);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('runAfterResponse', () => {
  it('should hand the work to afterResponse', () => {
    const afterResponse = vi.fn();
    const work = vi.fn(async () => {});

    runAfterResponse({ afterResponse }, work, () => {});

    expect(afterResponse).toHaveBeenCalledOnce();
    expect(work).not.toHaveBeenCalled();
  });

  it('should pass the errors of the work handed to afterResponse to onError', async () => {
    let handed!: () => Promise<unknown>;
    const onError = vi.fn();

    runAfterResponse(
      { afterResponse: (work) => (handed = work) },
      async () => {
        throw new Error('work failed');
      },
      onError
    );
    await handed();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'work failed' }));
  });

  it('should start the work at once and hand it to background without afterResponse', async () => {
    const background = vi.fn();
    const work = vi.fn(async () => 'done');

    runAfterResponse({ background }, work, () => {});

    expect(work).toHaveBeenCalledOnce();
    expect(background).toHaveBeenCalledOnce();
    await expect(background.mock.calls[0]?.[0]).resolves.toBe('done');
  });

  it('should start the work at once when afterResponse throws', () => {
    const onError = vi.fn();
    const onPlatformError = vi.fn();
    const work = vi.fn(async () => {});

    runAfterResponse(
      {
        afterResponse: () => {
          throw new Error('outside a request');
        },
      },
      work,
      onError,
      onPlatformError
    );

    expect(work).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(onPlatformError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'outside a request' })
    );
  });

  it('should run the work once when afterResponse throws after scheduling it', async () => {
    const scheduled: (() => Promise<unknown>)[] = [];
    const onPlatformError = vi.fn();
    const work = vi.fn(async () => {});

    runAfterResponse(
      {
        afterResponse: (handed) => {
          scheduled.push(handed);
          throw new Error('failed after scheduling');
        },
      },
      work,
      () => {},
      onPlatformError
    );
    // The platform runs what it scheduled, after the fallback started the work
    await Promise.all(scheduled.map((handed) => handed()));

    expect(work).toHaveBeenCalledOnce();
    expect(onPlatformError).toHaveBeenCalledOnce();
  });
});

describe('sharedStoreOperation', () => {
  it('should resolve to the fallback when the store does not answer in time', async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const result = sharedStoreOperation(
        () => new Promise<string>(() => {}),
        'fallback',
        300,
        onError
      );

      await vi.advanceTimersByTimeAsync(300);

      await expect(result).resolves.toBe('fallback');
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sharedStoreOperation failures', () => {
  it('should resolve to the fallback when the operation rejects', async () => {
    const onError = vi.fn();

    await expect(
      sharedStoreOperation(() => Promise.reject(new Error('store down')), 'fallback', 300, onError)
    ).resolves.toBe('fallback');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('should observe the rejection of an operation that fails after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const result = sharedStoreOperation(
        () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error('late')), 400)),
        'fallback',
        300,
        onError
      );

      // An unobserved rejection of the operation would fail the run
      await vi.advanceTimersByTimeAsync(500);

      await expect(result).resolves.toBe('fallback');
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('toTtlSeconds', () => {
  it.each([
    [0, 1],
    [1, 1],
    [1000, 1],
    [1001, 2],
    [-5, 1],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
  ])('should convert %s ms to %s s', (ms, seconds) => {
    expect(toTtlSeconds(ms)).toBe(seconds);
  });
});
