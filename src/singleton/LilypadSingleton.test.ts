import { describe, it, expect, vi } from 'vitest';
import {
  createLilypadSingletonAble,
  createLilypadSingletonAbleAsync,
  getLilypadSingletonInstance,
  getLilypadSingletonInstanceAsync,
  lilypadSingletonRegistryKey,
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
    const options = { singleton: uniqueId() };

    const a = await createLilypadSingletonAbleAsync('A', options, async () => ({ kind: 'a' }));
    const b = await createLilypadSingletonAbleAsync('B', options, async () => ({ kind: 'b' }));

    expect(a).toEqual({ kind: 'a' });
    expect(b).toEqual({ kind: 'b' });
  });

  it('should give the factory a release function that removes the singleton once', async () => {
    const options = { singleton: uniqueId() };
    let release!: () => void;
    const first = await createLilypadSingletonAbleAsync('A', options, async (r) => {
      release = r;
      return { value: 1 };
    });

    release();
    const second = await createLilypadSingletonAbleAsync('A', options, async () => ({ value: 2 }));
    // A second call must not remove the instance registered since
    release();
    const third = await createLilypadSingletonAbleAsync('A', options, async () => ({ value: 3 }));

    expect(second).not.toBe(first);
    expect(third).toBe(second);
  });

  it('should not remove, on release, an instance registered after a manual removal', async () => {
    const options = { singleton: uniqueId() };
    let releaseFirst!: () => void;
    await createLilypadSingletonAbleAsync('A', options, async (release) => {
      releaseFirst = release;
      return { value: 1 };
    });
    removeLilypadSingletonInstance(lilypadSingletonRegistryKey('A', options.singleton));
    const second = await createLilypadSingletonAbleAsync('A', options, async () => ({ value: 2 }));

    // The first instance is disposed only now: its release must leave the second one registered
    releaseFirst();

    expect(await createLilypadSingletonAbleAsync('A', options, async () => ({ value: 3 }))).toBe(
      second
    );
  });

  it('should release a synchronous singleton only while it is the registered one', () => {
    const options = { singleton: uniqueId() };
    let releaseFirst!: () => void;
    const first = createLilypadSingletonAble('S', options, (release) => {
      releaseFirst = release;
      return { value: 1 };
    });
    removeLilypadSingletonInstance(lilypadSingletonRegistryKey('S', options.singleton));
    const second = createLilypadSingletonAble('S', options, () => ({ value: 2 }));

    releaseFirst();

    expect(second).not.toBe(first);
    expect(createLilypadSingletonAble('S', options, () => ({ value: 3 }))).toBe(second);
  });

  it('should give a no-op release function to instances that are not singletons', async () => {
    const key = lilypadSingletonRegistryKey('A', uniqueId());
    const registered = getLilypadSingletonInstance(key, () => ({ value: 1 }));
    const instance = await createLilypadSingletonAbleAsync('A', {}, async (release) => {
      release();
      return { value: 2 };
    });

    expect(instance).toEqual({ value: 2 });
    expect(getLilypadSingletonInstance(key, () => ({ value: 3 }))).toBe(registered);
  });

  it('should create synchronous singletons with the same namespacing', () => {
    const options = { singleton: uniqueId() };
    let release!: () => void;
    const first = createLilypadSingletonAble('A', options, (r) => {
      release = r;
      return { value: 1 };
    });

    expect(createLilypadSingletonAble('A', options, () => ({ value: 2 }))).toBe(first);
    expect(createLilypadSingletonAble('B', options, () => ({ value: 3 }))).not.toBe(first);
    release();
    expect(createLilypadSingletonAble('A', options, () => ({ value: 4 }))).toEqual({ value: 4 });
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

  it('should forget the signature on release, so that a new instance may use other options', () => {
    const options = { singleton: uniqueId() };
    const onMismatch = vi.fn();
    let release!: () => void;
    createLilypadSingletonAble(
      'A',
      options,
      (r) => {
        release = r;
        return {};
      },
      { value: 'a', onMismatch }
    );

    release();
    createLilypadSingletonAble('A', options, () => ({}), { value: 'b', onMismatch });
    createLilypadSingletonAble('A', options, () => ({}), { value: 'b', onMismatch });

    expect(onMismatch).not.toHaveBeenCalled();
  });

  it('should keep the keys of the create methods apart from other versions of the registry', () => {
    const singleton = uniqueId();
    // What a copy of the library with an older key format registered under the same identifier
    const older = getLilypadSingletonInstance(`A:${singleton}`, () => ({ version: 0 }));

    const current = createLilypadSingletonAble('A', { singleton }, () => ({ version: 1 }));

    expect(current).not.toBe(older);
    expect(lilypadSingletonRegistryKey('A', singleton)).toBe(`A@1:${singleton}`);
  });

  it('should leave the registry empty when a failing creation calls its release', async () => {
    const options = { singleton: uniqueId() };

    await expect(
      createLilypadSingletonAbleAsync('A', options, async (release) => {
        await Promise.resolve();
        // e.g. a partially built instance disposed by its factory
        release();
        throw new Error('creation failed');
      })
    ).rejects.toThrow('creation failed');

    expect(
      removeLilypadSingletonInstance(lilypadSingletonRegistryKey('A', options.singleton))
    ).toBe(false);
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
