import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LilypadBackoff } from './LilypadBackoff';

describe('LilypadBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should be ready until a failure, then wait a doubling delay', () => {
    const backoff = new LilypadBackoff(() => 1000);
    expect(backoff.ready()).toBe(true);

    backoff.fail();
    vi.advanceTimersByTime(999);
    expect(backoff.ready()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(backoff.ready()).toBe(true);

    backoff.fail();
    vi.advanceTimersByTime(1999);
    expect(backoff.ready()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(backoff.ready()).toBe(true);
  });

  it('should cap the delay at one minute, unless the base delay is longer', () => {
    const short = new LilypadBackoff(() => 1000);
    const long = new LilypadBackoff(() => 120_000);
    for (let i = 0; i < 20; i++) {
      short.fail();
      long.fail();
    }

    vi.advanceTimersByTime(60_000);
    expect(short.ready()).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(long.ready()).toBe(false);
  });

  it('should start again from the base delay after a success', () => {
    const backoff = new LilypadBackoff(() => 1000);
    backoff.fail();
    backoff.fail();
    backoff.succeed();

    expect(backoff.ready()).toBe(true);
    backoff.fail();
    vi.advanceTimersByTime(1000);
    expect(backoff.ready()).toBe(true);
  });

  it('should keep a finite delay after many failures, even with a zero base delay', () => {
    const zero = new LilypadBackoff(() => 0);
    const capped = new LilypadBackoff(() => 1000);
    for (let i = 0; i < 2000; i++) {
      zero.fail();
      capped.fail();
    }

    expect(zero.ready()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(capped.ready()).toBe(true);
  });

  it('should not postpone the next attempt when the wall clock steps back', () => {
    const backoff = new LilypadBackoff(() => 1000);
    backoff.fail();

    vi.setSystemTime(Date.now() - 3_600_000);
    vi.advanceTimersByTime(1000);

    expect(backoff.ready()).toBe(true);
  });
});
