import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { LilypadDbMembers } from './LilypadDbMembers';

describe('LilypadDbMembers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const loaded = (...keys: string[]) => keys.map((key) => [key, key] as const);

  it('should track nothing until a load completed', () => {
    const members = new LilypadDbMembers<string>();

    members.add('a', 'a', 1);
    members.follow('b', 'b', true, 2);

    expect(members.tracked).toBe(false);
    expect(members.keys()).toEqual([]);
  });

  it('should keep the rows added and the rows deleted after the load started', () => {
    const members = new LilypadDbMembers<string>();
    members.replace(loaded('a'), 1, Date.now(), () => false);
    members.add('late', 'late', 5); // after the next load started (ticket 3)

    // The next load read 'a' and 'gone', but 'gone' was deleted after the load started
    members.replace(loaded('a', 'gone'), 3, Date.now(), (key) => key === 'gone');

    expect(members.keys().sort()).toEqual(['a', 'late']);
  });

  it('should ignore a stored value older than what the member knows', () => {
    const members = new LilypadDbMembers<string>();
    members.replace(loaded('a'), 1, Date.now(), () => false);

    members.follow('a', 'a', false, 0); // a null read before the load
    expect(members.keys()).toEqual(['a']);
    members.follow('a', 'a', false, 2);
    expect(members.keys()).toEqual([]);
  });

  it('should ignore a load started before the table was forgotten', () => {
    const members = new LilypadDbMembers<string>();
    members.replace(loaded('a'), 1, Date.now(), () => false);

    members.forget(10, true);
    members.replace(loaded('a', 'b'), 5, Date.now(), () => false);

    expect(members.keys()).toEqual([]);
    // Known empty: still loaded
    expect(members.isLoaded(undefined, 60_000)).toBe(true);
    members.forget(11, false);
    expect(members.isLoaded(undefined, 60_000)).toBe(false);
  });

  it('should count as loaded since the sync became trusted, or for the ttl without it', async () => {
    const members = new LilypadDbMembers<string>();
    const loadedAt = Date.now();
    members.replace(loaded('a'), 1, loadedAt, () => false);

    await vi.advanceTimersByTimeAsync(2000);

    expect(members.isLoaded(undefined, 1000)).toBe(false);
    expect(members.isLoaded(loadedAt, 1000)).toBe(true);
    expect(members.isLoaded(loadedAt + 1, 1000)).toBe(false);
  });
});
