import { createHash } from 'node:crypto';

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
 */
export type LilypadSingletonSignature = {
  value: string;
  onMismatch: () => void;
};

/**
 * Hashes the parts of a signature, so that secrets (e.g. connection strings) never sit in the
 * global registry in clear text.
 */
export function createLilypadSingletonSignatureValue(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

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
 * Shared implementation of the async `create` methods: builds a new instance, or returns the
 * singleton registered under `namespace:singletonIdentifier`.
 * The namespace keeps singletons of different classes apart even when they share an identifier.
 *
 * @param createInstanceFn - Receives the registry key of the singleton (undefined for a
 * non-singleton instance), which the instance must pass to `removeLilypadSingletonInstance`
 * when it is closed.
 */
export function createLilypadSingletonAbleAsync<T>(
  namespace: string,
  options: LilypadSingletonAble,
  createInstanceFn: (registryKey: string | undefined) => Promise<T>,
  signature?: LilypadSingletonSignature
): Promise<T> {
  if (!options.singleton) {
    return createInstanceFn(undefined);
  }
  const registryKey = `${namespace}:${options.singletonIdentifier}`;
  return getLilypadSingletonInstanceAsync(
    registryKey,
    () => createInstanceFn(registryKey),
    signature
  );
}
