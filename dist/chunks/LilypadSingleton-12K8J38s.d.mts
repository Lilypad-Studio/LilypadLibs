//#region src/singleton/LilypadSingleton.d.ts
declare global {
  var __lilypadSingletonMap: Map<string, unknown> | undefined;
  var __lilypadSingletonSignatureMap: Map<string, string> | undefined;
}
type LilypadSingletonAble = {
  singleton: true;
  singletonIdentifier: string;
} | {
  singleton?: false;
};
/**
 * Describes the options a singleton was created with. When a later call asks for the same
 * singleton with a different `value`, `onMismatch` is called: the existing instance is returned
 * anyway, so the options of that call are ignored.
 * The value is kept in a global map: hash it if the options contain secrets.
 */
type LilypadSingletonSignature = {
  value: string;
  onMismatch: () => void;
};
declare function getLilypadSingletonInstance<T>(identifier: string, createInstanceFn: () => T, signature?: LilypadSingletonSignature): T;
/**
 * Removes a singleton instance from the registry, so that the next `create` call with the same
 * identifier builds a fresh instance. Meant to be called when the instance is closed/disposed.
 *
 * @returns `true` if an instance was registered under the identifier.
 */
declare function removeLilypadSingletonInstance(identifier: string): boolean;
declare function getLilypadSingletonInstanceAsync<T>(identifier: string, createInstanceFn: () => Promise<T>, signature?: LilypadSingletonSignature): Promise<T>;
//#endregion
export { removeLilypadSingletonInstance as a, getLilypadSingletonInstanceAsync as i, LilypadSingletonSignature as n, getLilypadSingletonInstance as r, LilypadSingletonAble as t };
//# sourceMappingURL=LilypadSingleton-12K8J38s.d.mts.map