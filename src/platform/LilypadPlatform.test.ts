import { describe, it, expect, vi } from 'vitest';
import { runAfterResponse, runInBackground, sharedStoreOperation } from './LilypadPlatform';

describe('runInBackground', () => {
  it('should still run the task when the platform function throws', async () => {
    const onError = vi.fn();
    const task = vi.fn(async () => 'done');

    runInBackground(
      {
        background: () => {
          throw new Error('outside a request');
        },
      },
      task(),
      onError
    );
    await Promise.resolve();

    expect(task).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'outside a request' }));
  });

  it('should pass the errors of the task to onError', async () => {
    const onError = vi.fn();

    runInBackground(undefined, Promise.reject(new Error('task failed')), onError);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'task failed' }));
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

  it('should start the work at once when afterResponse throws', () => {
    const onError = vi.fn();
    const work = vi.fn(async () => {});

    runAfterResponse(
      {
        afterResponse: () => {
          throw new Error('outside a request');
        },
      },
      work,
      onError
    );

    expect(work).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'outside a request' }));
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
