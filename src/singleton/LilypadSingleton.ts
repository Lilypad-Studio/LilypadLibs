declare global {
  var __lilypadSingletonMap: Map<string, unknown> | undefined;
  var __lilypadSingletonSignatureMap: Map<string, string> | undefined;
}
const singletonMap = (globalThis.__lilypadSingletonMap ??= new Map<string, unknown>());
// Kept apart from singletonMap, so that bundles of older versions sharing the registry still read it
const signatureMap = (globalThis.__lilypadSingletonSignatureMap ??= new Map<string, string>());

export type LilypadSingletonAble =
  | {
      singleton: true;
      singletonIdentifier: string;
    }
  | {
      singleton?: false;
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
  return options.singleton ? `${namespace}:${options.singletonIdentifier}` : undefined;
}

function releaseFor(registryKey: string | undefined): LilypadSingletonRelease {
  let released = registryKey === undefined;
  return () => {
    if (!released) {
      released = true;
      removeLilypadSingletonInstance(registryKey!);
    }
  };
}

/**
 * Shared implementation of the synchronous `create` methods: builds a new instance, or returns the
 * singleton registered under `namespace:singletonIdentifier`.
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
    return createInstanceFn(releaseFor(undefined));
  }
  return getLilypadSingletonInstance(
    registryKey,
    () => createInstanceFn(releaseFor(registryKey)),
    signature
  );
}

/**
 * Shared implementation of the async `create` methods: builds a new instance, or returns the
 * singleton registered under `namespace:singletonIdentifier`.
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
    return createInstanceFn(releaseFor(undefined));
  }
  return getLilypadSingletonInstanceAsync(
    registryKey,
    () => createInstanceFn(releaseFor(registryKey)),
    signature
  );
}
