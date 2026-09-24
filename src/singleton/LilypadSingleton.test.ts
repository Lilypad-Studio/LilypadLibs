import { describe, it, expect, vi } from 'vitest';
import {
  getLilypadSingletonInstance,
  getLilypadSingletonInstanceAsync,
  removeLilypadSingletonInstance,
} from './LilypadSingleton';

// The registry is global: every test uses its own identifiers
let counter = 0;
const uniqueId = () => `LilypadSingleton.test-${counter++}`;

describe('LilypadSingleton', () => {
  it('should create the instance once and return it on later calls', () => {
    const id = uniqueId();
    const factory = vi.fn(() => ({ value: 1 }));

    const first = getLilypadSingletonInstance(id, factory);
    const second = getLilypadSingletonInstance(id, factory);

    expect(second).toBe(first);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('should call the async factory once for concurrent calls', async () => {
    const id = uniqueId();
    const factory = vi.fn(async () => ({ value: 1 }));

    const [first, second] = await Promise.all([
      getLilypadSingletonInstanceAsync(id, factory),
      getLilypadSingletonInstanceAsync(id, factory),
    ]);

    expect(second).toBe(first);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('should forget a failed async creation, so that the next call retries it', async () => {
    const id = uniqueId();
    const failingFactory = vi.fn(async () => {
      throw new Error('creation failed');
    });
    const workingFactory = vi.fn(async () => ({ value: 1 }));

    await expect(getLilypadSingletonInstanceAsync(id, failingFactory)).rejects.toThrow(
      'creation failed'
    );
    const instance = await getLilypadSingletonInstanceAsync(id, workingFactory);

    expect(instance).toEqual({ value: 1 });
    expect(workingFactory).toHaveBeenCalledOnce();
  });

  it('should create a new instance after the previous one is removed', () => {
    const id = uniqueId();
    const first = getLilypadSingletonInstance(id, () => ({ value: 1 }));

    expect(removeLilypadSingletonInstance(id)).toBe(true);
    const second = getLilypadSingletonInstance(id, () => ({ value: 2 }));

    expect(second).not.toBe(first);
    expect(second).toEqual({ value: 2 });
  });

  it('should return false when removing an unknown identifier', () => {
    expect(removeLilypadSingletonInstance(uniqueId())).toBe(false);
  });
});
