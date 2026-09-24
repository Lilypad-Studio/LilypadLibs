declare global {
  var __lilypadSingletonMap: Map<string, unknown> | undefined;
}
const singletonMap = (globalThis.__lilypadSingletonMap ??= new Map<string, unknown>());

export type LilypadSingletonAble =
  | {
      singleton: true;
      singletonIdentifier: string;
    }
  | {
      singleton?: false;
    };

export function getLilypadSingletonInstance<T>(identifier: string, createInstanceFn: () => T): T {
  if (singletonMap.has(identifier)) {
    return singletonMap.get(identifier) as T;
  }

  const instance = createInstanceFn();
  singletonMap.set(identifier, instance);
  return instance;
}

/**
 * Removes a singleton instance from the registry, so that the next `create` call with the same
 * identifier builds a fresh instance. Meant to be called when the instance is closed/disposed.
 *
 * @returns `true` if an instance was registered under the identifier.
 */
export function removeLilypadSingletonInstance(identifier: string): boolean {
  return singletonMap.delete(identifier);
}

export async function getLilypadSingletonInstanceAsync<T>(
  identifier: string,
  createInstanceFn: () => Promise<T>
): Promise<T> {
  if (singletonMap.has(identifier)) {
    return singletonMap.get(identifier) as T;
  }

  const instancePromise = createInstanceFn();
  singletonMap.set(identifier, instancePromise);

  try {
    const instance = await instancePromise;
    // Replace promise with resolved value
    singletonMap.set(identifier, instance);
    return instance;
  } catch (error) {
    // Remove failed promise from cache
    singletonMap.delete(identifier);
    throw error;
  }
}
