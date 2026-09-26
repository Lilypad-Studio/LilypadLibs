import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LilypadListenHeartbeat } from './LilypadListenHeartbeat';

describe('LilypadListenHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should be unhealthy until started', () => {
    const heartbeat = new LilypadListenHeartbeat(1000, async () => {}, vi.fn());

    expect(heartbeat.healthy()).toBe(false);
    heartbeat.start();
    expect(heartbeat.healthy()).toBe(true);
    heartbeat.stop();
  });

  it('should send a beat every interval and stay healthy while beats come back', async () => {
    // Each heartbeat comes back at once
    const send = vi.fn(async () => heartbeat.beat());
    const heartbeat = new LilypadListenHeartbeat(1000, send, vi.fn());
    heartbeat.start();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(send).toHaveBeenCalledTimes(10);
    expect(heartbeat.healthy()).toBe(true);
    heartbeat.stop();
  });

  it('should become unhealthy when beats stop coming back, and recover with the next one', async () => {
    const onError = vi.fn();
    const heartbeat = new LilypadListenHeartbeat(
      1000,
      async () => {
        throw new Error('connection lost');
      },
      onError
    );
    heartbeat.start();

    await vi.advanceTimersByTimeAsync(2500);
    expect(heartbeat.healthy()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(heartbeat.healthy()).toBe(false);
    expect(onError).toHaveBeenCalled();

    heartbeat.beat();
    expect(heartbeat.healthy()).toBe(true);
    heartbeat.stop();
  });

  it('should ignore beats once stopped', () => {
    const heartbeat = new LilypadListenHeartbeat(1000, async () => {}, vi.fn());
    heartbeat.start();
    heartbeat.stop();

    heartbeat.beat();

    expect(heartbeat.healthy()).toBe(false);
    expect(heartbeat.running).toBe(false);
  });
});
