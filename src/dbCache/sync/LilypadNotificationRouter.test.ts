import { describe, it, expect, vi } from 'vitest';
import {
  LilypadNotificationRouter,
  parseLilypadNotification,
  type LilypadNotificationSubscriber,
} from './LilypadNotificationRouter';
import type { LilypadDbGate, LilypadDbListener } from '@/dbGate/LilypadDbGate';

function createGate() {
  const listeners = new Map<string, LilypadDbListener>();
  const gate = {
    addListener: vi.fn(async (listener: LilypadDbListener) => {
      listeners.set(listener.callbackId, listener);
    }),
    removeListener: vi.fn(async (_channel: string, callbackId: string) =>
      listeners.delete(callbackId)
    ),
  };
  return { gate: gate as unknown as LilypadDbGate, mocks: gate, listeners };
}

const subscriber = (table: string): LilypadNotificationSubscriber => ({
  table,
  handle: vi.fn(),
  onReconnect: vi.fn(),
  log: vi.fn(),
});

describe('parseLilypadNotification', () => {
  it('should accept BULK and TRUNCATE without an id, and require one otherwise', () => {
    expect(parseLilypadNotification('{"table":"t","op":"BULK"}')).toEqual({
      table: 't',
      op: 'BULK',
    });
    expect(parseLilypadNotification('{"table":"t","op":"TRUNCATE"}')).toBeDefined();
    expect(parseLilypadNotification('{"table":"t","op":"UPDATE"}')).toBeUndefined();
    expect(parseLilypadNotification('{"table":"t","op":"MERGE","id":"1"}')).toBeUndefined();
  });

  it('should refuse an id with a lone surrogate, which no row can have', () => {
    const payload = (id: string) => JSON.stringify({ table: 't', op: 'UPDATE', id });

    expect(parseLilypadNotification(payload(String.fromCharCode(0xd800)))).toBeUndefined();
    expect(parseLilypadNotification(payload(String.fromCharCode(0xd83d, 0xde00)))).toBeDefined();
  });
});

describe('LilypadNotificationRouter', () => {
  it('should listen once, and hand each notification to the subscribers of its table', async () => {
    const { gate, mocks, listeners } = createGate();
    const router = new LilypadNotificationRouter(gate, 'cache_events');
    const items = subscriber('items');
    const users = subscriber('users');

    await Promise.all([router.subscribe(items), router.subscribe(users)]);
    await listeners
      .get('lilypad_notification_router')!
      .callback('{"table":"items","id":"1","op":"UPDATE"}');

    expect(mocks.addListener).toHaveBeenCalledOnce();
    expect(items.handle).toHaveBeenCalledWith({ table: 'items', id: '1', op: 'UPDATE' });
    expect(users.handle).not.toHaveBeenCalled();
  });

  it('should log a malformed notification once, and the error of a subscriber with its own log', async () => {
    const { gate, listeners } = createGate();
    const router = new LilypadNotificationRouter(gate, 'cache_events');
    const first = subscriber('items');
    const second = subscriber('items');
    vi.mocked(second.handle).mockRejectedValue(new Error('apply failed'));
    await router.subscribe(first);
    await router.subscribe(second);
    const callback = listeners.get('lilypad_notification_router')!.callback;

    await callback('not json');
    await callback('{"table":"items","id":"1","op":"UPDATE"}');

    expect(first.log).toHaveBeenCalledExactlyOnceWith(
      'warn',
      expect.stringContaining('malformed'),
      'not json'
    );
    expect(second.log).toHaveBeenCalledWith('error', expect.any(String), expect.any(Error));
    expect(first.handle).toHaveBeenCalledOnce();
  });

  it('should log the malformed notifications at most once a minute, counting the others', async () => {
    vi.useFakeTimers();
    try {
      const { gate, listeners } = createGate();
      const router = new LilypadNotificationRouter(gate, 'cache_events');
      const items = subscriber('items');
      await router.subscribe(items);
      const callback = listeners.get('lilypad_notification_router')!.callback;

      for (let index = 0; index < 1000; index++) {
        await callback('not json');
      }
      expect(items.log).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(60_000);
      await callback('still not json');
      expect(items.log).toHaveBeenLastCalledWith(
        'warn',
        'Ignoring a malformed cache_events notification (and 999 more since the last warning):',
        'still not json'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('should stop listening with the last subscriber, unless one subscribes again meanwhile', async () => {
    const { gate, mocks } = createGate();
    const router = new LilypadNotificationRouter(gate, 'cache_events');
    const first = subscriber('items');
    const second = subscriber('items');
    await router.subscribe(first);

    const leaving = router.unsubscribe(first);
    const joining = router.subscribe(second);
    await Promise.all([leaving, joining]);

    expect(mocks.removeListener).not.toHaveBeenCalled();
    await router.unsubscribe(second);
    expect(mocks.removeListener).toHaveBeenCalledOnce();
  });

  it('should not subscribe a cache whose LISTEN fails, and retry on the next subscription', async () => {
    const { gate, mocks } = createGate();
    mocks.addListener.mockRejectedValueOnce(new Error('unreachable'));
    const router = new LilypadNotificationRouter(gate, 'cache_events');
    const items = subscriber('items');

    await expect(router.subscribe(items)).rejects.toThrow('unreachable');
    await router.subscribe(items);

    expect(mocks.addListener).toHaveBeenCalledTimes(2);
  });

  it('should tell every subscriber about a reconnection', async () => {
    const { gate, listeners } = createGate();
    const router = new LilypadNotificationRouter(gate, 'cache_events');
    const items = subscriber('items');
    const users = subscriber('users');
    await router.subscribe(items);
    await router.subscribe(users);

    await listeners.get('lilypad_notification_router')!.onReconnect!();

    expect(items.onReconnect).toHaveBeenCalledOnce();
    expect(users.onReconnect).toHaveBeenCalledOnce();
  });
});
