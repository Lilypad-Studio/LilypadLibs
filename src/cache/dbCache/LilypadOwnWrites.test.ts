import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { LilypadOwnWrites } from './LilypadOwnWrites';

describe('LilypadOwnWrites', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should recognize a write while the entry holds its result, once', () => {
    const writes = new LilypadOwnWrites();
    writes.record('k', 10n, 7);

    expect(writes.consume('k', 10n, 7)).toBe(true);
    expect(writes.consume('k', 10n, 7)).toBe(false);
  });

  it('should not skip the change of a write whose result was replaced since', () => {
    const writes = new LilypadOwnWrites();
    writes.record('k', 10n, 7);

    expect(writes.consume('k', 10n, 8)).toBe(false);
    expect(writes.consume('other', 10n, 7)).toBe(false);
  });

  it('should forget the writes a cursor covers, and those older than ten minutes', async () => {
    const writes = new LilypadOwnWrites();
    writes.record('covered', 10n, 1);
    writes.record('running', 20n, 2);
    writes.forgetCoveredBy({ xmax: 30n, xip: [20n] });

    expect(writes.consume('covered', 10n, 1)).toBe(false);
    expect(writes.consume('running', 20n, 2)).toBe(true);

    writes.record('old', 40n, 3);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    writes.record('new', 50n, 4); // prunes the old ones
    expect(writes.consume('old', 40n, 3)).toBe(false);
    expect(writes.consume('new', 50n, 4)).toBe(true);
  });
});
