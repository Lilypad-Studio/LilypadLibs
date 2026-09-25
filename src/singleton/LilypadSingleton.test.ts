import { describe, it, expect, vi } from 'vitest';
import {
  createLilypadSingletonAbleAsync,
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

  it('should keep singletons of different namespaces apart', async () => {
    const options = { singleton: true as const, singletonIdentifier: uniqueId() };

    const a = await createLilypadSingletonAbleAsync('A', options, async () => ({ kind: 'a' }));
    const b = await createLilypadSingletonAbleAsync('B', options, async () => ({ kind: 'b' }));

    expect(a).toEqual({ kind: 'a' });
    expect(b).toEqual({ kind: 'b' });
  });

  it('should pass the registry key to the factory, or undefined without singleton', async () => {
    const identifier = uniqueId();
    const factory = vi.fn(async (registryKey: string | undefined) => ({ registryKey }));

    await createLilypadSingletonAbleAsync('A', {}, factory);
    await createLilypadSingletonAbleAsync(
      'A',
      { singleton: true, singletonIdentifier: identifier },
      factory
    );

    expect(factory.mock.calls).toEqual([[undefined], [`A:${identifier}`]]);
  });

  it('should report later calls with a different signature', () => {
    const id = uniqueId();
    const onMismatch = vi.fn();

    const first = getLilypadSingletonInstance(id, () => ({}), { value: 'a', onMismatch });
    getLilypadSingletonInstance(id, () => ({}), { value: 'a', onMismatch });
    expect(onMismatch).not.toHaveBeenCalled();

    const second = getLilypadSingletonInstance(id, () => ({}), { value: 'b', onMismatch });
    expect(onMismatch).toHaveBeenCalledOnce();
    expect(second).toBe(first);
  });

  it('should refuse a synchronous lookup of a singleton being created asynchronously', async () => {
    const id = uniqueId();
    const pending = getLilypadSingletonInstanceAsync(id, async () => ({}));

    expect(() => getLilypadSingletonInstance(id, () => ({}))).toThrow('asynchronously');
    await pending;
  });

  it('should not remove an entry registered while a failed creation was pending', async () => {
    const id = uniqueId();
    let rejectCreation!: (error: Error) => void;
    const failing = getLilypadSingletonInstanceAsync(
      id,
      () => new Promise<object>((_, reject) => (rejectCreation = reject))
    );

    removeLilypadSingletonInstance(id);
    const replacement = getLilypadSingletonInstance(id, () => ({ value: 2 }));
    rejectCreation(new Error('creation failed'));
    await expect(failing).rejects.toThrow('creation failed');

    expect(getLilypadSingletonInstance(id, () => ({ value: 3 }))).toBe(replacement);
  });
});
