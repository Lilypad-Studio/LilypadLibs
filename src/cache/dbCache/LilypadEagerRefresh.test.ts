import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { LilypadEagerRefresh } from './LilypadEagerRefresh';

describe('LilypadEagerRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should read the keys added together in one batch, counted until it ends', async () => {
    let finish!: () => void;
    const read = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const eager = new LilypadEagerRefresh<string>(read);

    const first = eager.refresh('a', 'a');
    const second = eager.refresh('b', 'b');
    const again = eager.refresh('a', 'a');
    await vi.advanceTimersByTimeAsync(0);

    expect(read).toHaveBeenCalledExactlyOnceWith(['a', 'b']);
    expect(second).toBe(first);
    expect(again).toBe(first);
    expect(eager.has('a')).toBe(true);
    finish();
    await first;
    expect(eager.has('a')).toBe(false);
  });

  it('should start a new batch for the keys added once the previous one is sent', async () => {
    const read = vi.fn(() => Promise.resolve());
    const eager = new LilypadEagerRefresh<string>(read);

    await eager.refresh('a', 'a');
    await eager.refresh('a', 'a');

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('should refuse the keys beyond the budget of the second, then take them again', async () => {
    const eager = new LilypadEagerRefresh<string>(() => Promise.resolve());
    for (let index = 0; index < 1000; index++) {
      expect(eager.refresh(`k${index}`, `k${index}`)).toBeDefined();
    }

    expect(eager.refresh('over', 'over')).toBeUndefined();
    // A key of the batch being gathered costs nothing
    expect(eager.refresh('k0', 'k0')).toBeDefined();

    await vi.advanceTimersByTimeAsync(1000);
    expect(eager.refresh('over', 'over')).toBeDefined();
  });
});
