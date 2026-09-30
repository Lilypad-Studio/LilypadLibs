/**
 * The registry lives on `globalThis`, so that every copy of the library in the process shares it.
 * Typed here rather than with `declare global`, which the declarations of the package would publish
 * into the global types of the applications.
 */
const registry = globalThis as typeof globalThis & {
  __lilypadSingletonMap?: Map<string, unknown> | undefined;
  __lilypadSingletonSignatureMap?: Map<string, string> | undefined;
};
const singletonMap = (registry.__lilypadSingletonMap ??= new Map<string, unknown>());
// Kept apart from singletonMap, so that bundles of older versions sharing the registry still read it
const signatureMap = (registry.__lilypadSingletonSignatureMap ??= new Map<string, string>());

/**
 * Part of the keys of the `create` methods (`<namespace>@<version>:<singleton>`). The registry is
 * shared by every copy of the library in the process: bump it when an instance changes in a way
 * another copy could not use, so that incompatible copies never hand each other their instances.
 */
const SINGLETON_REGISTRY_VERSION = 1;

/** The registry key of a singleton created by a `create` method: `<namespace>@<version>:<singleton>`. */
export function lilypadSingletonRegistryKey(namespace: string, singleton: string): string {
  return `${namespace}@${SINGLETON_REGISTRY_VERSION}:${singleton}`;
}

/**
 * The singleton option of the `create` methods: with an identifier, a later `create` with the same
 * identifier returns the same instance; without one, each call creates a new instance.
 */
export type LilypadSingletonAble = {
  /** The identifier of the singleton, unique among the instances of the class. */
  singleton?: string | undefined;
};

/**
 * Describes the options a singleton was created with. When a later call asks for the same
 * singleton with a different `value`, `onMismatch` is called: the existing instance is returned
 * anyway, so the options of that call are ignored.
 * The value is kept in a global map: hash it if the options contain secrets.
 */
export type LilypadSingletonSignature = {
  value: string;
  onMismatch: () => void;
};

function checkSignature(identifier: string, signature?: LilypadSingletonSignature) {
  if (!signature) {
    return;
  }
  const stored = signatureMap.get(identifier);
  if (stored === undefined) {
    signatureMap.set(identifier, signature.value);
  } else if (stored !== signature.value) {
    signature.onMismatch();
  }
}

/**
 * Returns the instance registered under `identifier`, or creates it with `createInstanceFn` and
 * registers it. The registry is shared by the whole process (it lives on `globalThis`), including
 * the copies of the library loaded by other bundles: use identifiers unique in the application.
 *
 * @param signature - Describes the options of this call: `onMismatch` is called when they differ
 * from those of the call that created the instance, which is returned anyway.
 * @throws If the instance is still being created by {@link getLilypadSingletonInstanceAsync}.
 */
export function getLilypadSingletonInstance<T>(
  identifier: string,
  createInstanceFn: () => T,
  signature?: LilypadSingletonSignature
): T {
  if (singletonMap.has(identifier)) {
    const existing = singletonMap.get(identifier);
    if (existing instanceof Promise) {
      throw new Error(
        `Singleton "${identifier}" is being created asynchronously: use getLilypadSingletonInstanceAsync.`
      );
    }
    checkSignature(identifier, signature);
    return existing as T;
  }

  const instance = createInstanceFn();
  singletonMap.set(identifier, instance);
  signatureMap.delete(identifier);
  checkSignature(identifier, signature);
  return instance;
}

/**
 * Removes a singleton instance from the registry, so that the next `create` call with the same
 * identifier builds a fresh instance. Meant to be called when the instance is closed/disposed.
 *
 * @returns `true` if an instance was registered under the identifier.
 */
export function removeLilypadSingletonInstance(identifier: string): boolean {
  signatureMap.delete(identifier);
  return singletonMap.delete(identifier);
}

/**
 * Like {@link getLilypadSingletonInstance}, for an instance created asynchronously: concurrent
 * callers share one creation. A creation that fails is forgotten, so the next call tries again.
 */
export async function getLilypadSingletonInstanceAsync<T>(
  identifier: string,
  createInstanceFn: () => Promise<T>,
  signature?: LilypadSingletonSignature
): Promise<T> {
  if (singletonMap.has(identifier)) {
    checkSignature(identifier, signature);
    return singletonMap.get(identifier) as T;
  }

  const instancePromise = createInstanceFn();
  singletonMap.set(identifier, instancePromise);
  signatureMap.delete(identifier);
  checkSignature(identifier, signature);

  try {
    const instance = await instancePromise;
    // Replace the promise with the resolved value, unless the entry was removed or replaced meanwhile
    if (singletonMap.get(identifier) === instancePromise) {
      singletonMap.set(identifier, instance);
    }
    return instance;
  } catch (error) {
    // Forget the failed creation, without touching an entry created by someone else meanwhile
    if (singletonMap.get(identifier) === instancePromise) {
      removeLilypadSingletonInstance(identifier);
    }
    throw error;
  }
}

/**
 * Removes an instance from the registry, so that the next `create` call with the same identifier
 * builds a fresh one. Idempotent, and a no-op for an instance that is not a singleton. Instances
 * call it when they are closed or disposed.
 */
export type LilypadSingletonRelease = () => void;

function registryKeyOf(namespace: string, options: LilypadSingletonAble): string | undefined {
  // The namespace keeps singletons of different classes apart even when they share an identifier
  return options.singleton !== undefined
    ? lilypadSingletonRegistryKey(namespace, options.singleton)
    : undefined;
}

/** What a factory registered under a key: the instance, or the promise of it while it is created. */
type LilypadSingletonOwner = { registered?: unknown; instance?: unknown };

/**
 * The release function of an instance: it removes the registry entry only if it still holds that
 * instance, not one registered under the same key since (e.g. after a manual removal).
 */
function releaseFor(
  registryKey: string | undefined,
  owner: LilypadSingletonOwner
): LilypadSingletonRelease {
  let released = registryKey === undefined;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const current = singletonMap.get(registryKey!);
    if (current !== undefined && (current === owner.instance || current === owner.registered)) {
      removeLilypadSingletonInstance(registryKey!);
    }
  };
}

/**
 * Shared implementation of the synchronous `create` methods: builds a new instance, or returns the
 * singleton registered under `lilypadSingletonRegistryKey(namespace, singleton)`.
 *
 * @param createInstanceFn - Receives the function that removes the instance from the registry.
 */
export function createLilypadSingletonAble<T>(
  namespace: string,
  options: LilypadSingletonAble,
  createInstanceFn: (release: LilypadSingletonRelease) => T,
  signature?: LilypadSingletonSignature
): T {
  const registryKey = registryKeyOf(namespace, options);
  if (registryKey === undefined) {
    return createInstanceFn(releaseFor(undefined, {}));
  }
  const owner: LilypadSingletonOwner = {};
  return getLilypadSingletonInstance(
    registryKey,
    () => {
      const instance = createInstanceFn(releaseFor(registryKey, owner));
      owner.instance = instance;
      return instance;
    },
    signature
  );
}

/**
 * Shared implementation of the async `create` methods: builds a new instance, or returns the
 * singleton registered under `lilypadSingletonRegistryKey(namespace, singleton)`.
 *
 * @param createInstanceFn - Receives the function that removes the instance from the registry.
 */
export function createLilypadSingletonAbleAsync<T>(
  namespace: string,
  options: LilypadSingletonAble,
  createInstanceFn: (release: LilypadSingletonRelease) => Promise<T>,
  signature?: LilypadSingletonSignature
): Promise<T> {
  const registryKey = registryKeyOf(namespace, options);
  if (registryKey === undefined) {
    return createInstanceFn(releaseFor(undefined, {}));
  }
  const owner: LilypadSingletonOwner = {};
  return getLilypadSingletonInstanceAsync(
    registryKey,
    () => {
      const registered = createInstanceFn(releaseFor(registryKey, owner)).then((instance) => {
        owner.instance = instance;
        return instance;
      });
      // Registered as it is while the instance is created
      owner.registered = registered;
      return registered;
    },
    signature
  );
}
