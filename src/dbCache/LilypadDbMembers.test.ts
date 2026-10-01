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

  it('should know the rows once loaded, until a change of the whole table voids the load', () => {
    const members = new LilypadDbMembers<string>();
    expect(members.known).toBe(false);
    members.replace(loaded('a'), 1, Date.now(), () => false);
    expect(members.known).toBe(true);

    // A TRUNCATE read from the changelog: the table is known to be empty
    members.forget(2, true);
    members.replace(loaded('a'), 1, Date.now(), () => false);
    expect(members.known).toBe(true);
    // A BULK change: a load started before it does not make the rows known again
    members.forget(3, false);
    members.replace(loaded('a'), 2, Date.now(), () => false);
    expect(members.known).toBe(false);
  });

  it('should not count a load made before the sync became trusted again, even within the TTL', () => {
    const members = new LilypadDbMembers<string>();
    const loadedAt = Date.now();
    members.replace(loaded('a'), 1, loadedAt, () => false);

    expect(members.isLoaded(loadedAt, 60_000)).toBe(true);
    // e.g. a LISTEN reconnection: the rows inserted meanwhile may be missing
    expect(members.isLoaded(loadedAt + 1, 60_000)).toBe(false);
  });

  it('should track the members while the first load runs, and keep them after it', () => {
    const members = new LilypadDbMembers<string>();
    members.beginLoad();

    members.add('inserted', 'inserted', 5); // after the load started (ticket 3)
    members.follow('fetched', 'fetched', true, 6);
    members.replace(loaded('a'), 3, Date.now(), () => false);
    members.endLoad();

    expect(members.keys().sort()).toEqual(['a', 'fetched', 'inserted']);
  });

  it('should not track the members once a failed load ended', () => {
    const members = new LilypadDbMembers<string>();
    members.beginLoad();
    members.endLoad();

    members.add('a', 'a', 1);

    expect(members.tracked).toBe(false);
    expect(members.keys()).toEqual([]);
  });

  it('should forget the members noted beyond a quarter of the table, at least 1000', () => {
    const members = new LilypadDbMembers<string>();
    members.replace(loaded('a', 'b'), 1, Date.now(), () => false);

    for (let index = 0; index < 1000; index++) {
      members.add(`n${index}`, `n${index}`, 2 + index);
    }
    expect(members.size).toBe(1002);
    // A fetched member is verified: it no longer counts
    members.follow('n0', 'n0', true, 5000);
    members.add('n1000', 'n1000', 5001);
    expect(members.size).toBe(1003);

    members.add('n1001', 'n1001', 5002);
    expect(members.size).toBe(0);
    expect(members.isLoaded(undefined, 60_000)).toBe(false);
  });

  it('should not forget the members while a load runs, but at the next add after it', () => {
    const members = new LilypadDbMembers<string>();
    members.beginLoad();
    for (let index = 0; index < 1001; index++) {
      members.add(`n${index}`, `n${index}`, 5 + index);
    }
    members.replace(loaded('a'), 3, Date.now(), () => false);
    members.endLoad();
    expect(members.size).toBe(1002);

    members.add('late', 'late', 2000);
    expect(members.size).toBe(0);
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
