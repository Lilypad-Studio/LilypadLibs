import { describe, it, expect } from 'vitest';
import { LilypadReadFlights } from './LilypadReadFlights';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('LilypadReadFlights', () => {
  it('should join a read that started after the current ticket of the key only', () => {
    const flights = new LilypadReadFlights<string>();
    const read = deferred<string>();
    flights.start(['k'], 5, read.promise);

    expect(flights.join('k', 4)).toBe(read.promise);
    // The key changed after the read started (its ticket is now 6): the read may be outdated
    expect(flights.join('k', 6)).toBeUndefined();
    expect(flights.join('other', 0)).toBeUndefined();
  });

  it('should keep counting a superseded read until it settles', async () => {
    const flights = new LilypadReadFlights<string>();
    const older = deferred<string>();
    const newer = deferred<string>();
    flights.start(['k'], 1, older.promise);
    flights.start(['k'], 3, newer.promise);

    expect(flights.join('k', 2)).toBe(newer.promise);
    newer.resolve('new');
    await newer.promise;
    await Promise.resolve();

    // The older read is still in flight: the fences of the cache must keep discarding it
    expect(flights.join('k', 0)).toBeUndefined();
    expect(flights.has('k')).toBe(true);
    older.resolve('old');
    await older.promise;
    await Promise.resolve();
    expect(flights.has('k')).toBe(false);
  });

  it('should forget a read of several keys once it fails', async () => {
    const flights = new LilypadReadFlights<string>();
    const failing = Promise.reject(new Error('down'));
    flights.start(['a', 'b'], 1, failing);

    await failing.catch(() => {});
    await Promise.resolve();

    expect(flights.has('a')).toBe(false);
    expect(flights.has('b')).toBe(false);
  });
});
