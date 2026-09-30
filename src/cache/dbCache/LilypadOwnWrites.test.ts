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

  it('should remember the last 32 transactions of a key written again and again', async () => {
    const writes = new LilypadOwnWrites();
    for (let xid = 1n; xid <= 40n; xid++) {
      writes.record('hot', xid, 1);
      await vi.advanceTimersByTimeAsync(60_000); // never older than the retention
    }

    expect(writes.consume('hot', 8n, 1)).toBe(false);
    expect(writes.consume('hot', 9n, 1)).toBe(true);
    expect(writes.consume('hot', 40n, 1)).toBe(true);
  });

  it('should measure the retention on the monotonic clock', async () => {
    const writes = new LilypadOwnWrites();
    writes.record('k', 10n, 1);

    // The wall clock steps back: the write still ages
    vi.setSystemTime(Date.now() - 60 * 60_000);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    writes.record('other', 20n, 2);

    expect(writes.consume('k', 10n, 1)).toBe(false);
  });
});
