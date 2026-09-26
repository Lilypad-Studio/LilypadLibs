import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LilypadDbGate } from './LilypadDbGate';
import type { LilypadChangesRequest } from './LilypadChangelog';
import {
  getLilypadChangelogReader,
  LilypadChangelogReader,
  type LilypadChangelogSubscriber,
} from './LilypadChangelogReader';

// The query itself is covered by the integration tests
const batch = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/dbGate/LilypadChangelog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/dbGate/LilypadChangelog')>()),
  readLilypadChangesBatch: batch.read,
}));

const gate = {} as LilypadDbGate;
const cursor = { xmax: 10n, xip: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A subscriber that reads the changes of `table` since a lookback, and records what it applies. */
function subscriber(table: string) {
  const applied: unknown[][] = [];
  const value: LilypadChangelogSubscriber = {
    request: vi.fn((): LilypadChangesRequest => ({ tableName: table, since: { lookback: 0 } })),
    apply: vi.fn((result) => {
      applied.push(result.changes);
    }),
  };
  return { value, applied };
}

describe('LilypadChangelogReader', () => {
  beforeEach(() => {
    batch.read.mockReset();
  });

  it('should read the tables of every subscriber in one query, and give each its own changes', async () => {
    const reader = new LilypadChangelogReader(gate, 'changes');
    const users = subscriber('users');
    const orders = subscriber('orders');
    reader.subscribe(users.value);
    reader.subscribe(orders.value);
    batch.read.mockResolvedValue({ changes: [['u'], ['o']], cursor });

    await reader.read(users.value);

    expect(batch.read).toHaveBeenCalledOnce();
    expect(batch.read).toHaveBeenCalledWith(gate, {
      changelogTable: 'changes',
      requests: [
        { tableName: 'users', since: { lookback: 0 } },
        { tableName: 'orders', since: { lookback: 0 } },
      ],
    });
    expect(users.applied).toEqual([['u']]);
    expect(orders.applied).toEqual([['o']]);
  });

  it('should share a read in progress with a subscriber it includes', async () => {
    const reader = new LilypadChangelogReader(gate, 'changes');
    const users = subscriber('users');
    reader.subscribe(users.value);
    const query = deferred<unknown>();
    batch.read.mockReturnValue(query.promise);

    const first = reader.read(users.value);
    const second = reader.read(users.value);
    query.resolve({ changes: [[]], cursor });
    await Promise.all([first, second]);

    expect(batch.read).toHaveBeenCalledOnce();
  });

  it('should queue one more read for a subscriber that the read in progress does not include', async () => {
    const reader = new LilypadChangelogReader(gate, 'changes');
    const users = subscriber('users');
    const orders = subscriber('orders');
    const products = subscriber('products');
    reader.subscribe(users.value);
    const query = deferred<unknown>();
    batch.read.mockReturnValueOnce(query.promise);
    batch.read.mockResolvedValue({ changes: [[], [], []], cursor });

    const first = reader.read(users.value);
    reader.subscribe(orders.value);
    reader.subscribe(products.value);
    const second = reader.read(orders.value);
    const third = reader.read(products.value);
    query.resolve({ changes: [[]], cursor });
    await Promise.all([first, second, third]);

    // The subscribers that joined share the queued read, which includes every subscriber
    expect(batch.read).toHaveBeenCalledTimes(2);
    expect(batch.read.mock.calls[1]![1].requests).toHaveLength(3);
  });

  it('should reject every caller of a failed read, and read again on the next call', async () => {
    const reader = new LilypadChangelogReader(gate, 'changes');
    const users = subscriber('users');
    reader.subscribe(users.value);
    batch.read.mockRejectedValueOnce(new Error('database unreachable'));
    batch.read.mockResolvedValue({ changes: [[]], cursor });

    await expect(Promise.all([reader.read(users.value), reader.read(users.value)])).rejects.toThrow(
      'database unreachable'
    );
    await expect(reader.read(users.value)).resolves.toBeUndefined();

    expect(batch.read).toHaveBeenCalledTimes(2);
    expect(users.applied).toEqual([[]]);
  });

  it('should not let a failing subscriber affect the others', async () => {
    const reader = new LilypadChangelogReader(gate, 'changes');
    const failing = subscriber('users');
    vi.mocked(failing.value.apply).mockRejectedValue(new Error('apply failed'));
    const orders = subscriber('orders');
    reader.subscribe(failing.value);
    reader.subscribe(orders.value);
    batch.read.mockResolvedValue({ changes: [[], ['o']], cursor });

    await expect(reader.read(orders.value)).resolves.toBeUndefined();
    expect(orders.applied).toEqual([['o']]);
  });

  it('should stop reading for a subscriber once unsubscribed', async () => {
    const reader = new LilypadChangelogReader(gate, 'changes');
    const users = subscriber('users');
    const orders = subscriber('orders');
    const unsubscribe = reader.subscribe(users.value);
    reader.subscribe(orders.value);
    batch.read.mockResolvedValue({ changes: [[]], cursor });

    unsubscribe();
    await reader.read(orders.value);

    expect(batch.read.mock.calls[0]![1].requests).toEqual([
      { tableName: 'orders', since: { lookback: 0 } },
    ]);
    expect(users.value.request).not.toHaveBeenCalled();
  });

  it('should share one reader per gate and changelog table', () => {
    const otherGate = {} as LilypadDbGate;

    expect(getLilypadChangelogReader(gate)).toBe(getLilypadChangelogReader(gate));
    expect(getLilypadChangelogReader(gate, 'custom')).not.toBe(getLilypadChangelogReader(gate));
    expect(getLilypadChangelogReader(otherGate)).not.toBe(getLilypadChangelogReader(gate));
  });
});
