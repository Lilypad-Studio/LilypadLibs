import { describe, it, expect } from 'vitest';
import { LilypadBackoff } from './LilypadBackoff';

describe('LilypadBackoff', () => {
  it('should be ready until a failure, then wait a doubling delay', () => {
    const backoff = new LilypadBackoff(() => 1000);
    expect(backoff.ready(0)).toBe(true);

    backoff.fail(0);
    expect(backoff.ready(999)).toBe(false);
    expect(backoff.ready(1000)).toBe(true);

    backoff.fail(1000);
    expect(backoff.ready(2999)).toBe(false);
    expect(backoff.ready(3000)).toBe(true);
  });

  it('should cap the delay at one minute, unless the base delay is longer', () => {
    const short = new LilypadBackoff(() => 1000);
    const long = new LilypadBackoff(() => 120_000);
    for (let i = 0; i < 20; i++) {
      short.fail(0);
      long.fail(0);
    }

    expect(short.ready(60_000)).toBe(true);
    expect(long.ready(119_999)).toBe(false);
  });

  it('should start again from the base delay after a success', () => {
    const backoff = new LilypadBackoff(() => 1000);
    backoff.fail(0);
    backoff.fail(0);
    backoff.succeed();

    expect(backoff.ready(0)).toBe(true);
    backoff.fail(0);
    expect(backoff.ready(1000)).toBe(true);
  });
});
