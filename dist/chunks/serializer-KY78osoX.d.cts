//#region src/serializer/LilypadSerializer.d.ts
type InvertRecord<R extends Record<PropertyKey, PropertyKey>> = { [K in keyof R as R[K]]: K; };
/** True if every key of B is the target of at least one key of the mapping. */
type IsSurjective<B extends object, M extends Record<PropertyKey, PropertyKey>> = keyof B extends M[keyof M] ? true : false;
/** True if no two keys of the mapping have the same target. */
type IsInjective<M extends Record<PropertyKey, PropertyKey>> = { [K in keyof M]: M[K] extends keyof InvertRecord<M> ? [InvertRecord<M>[M[K]]] extends [K] ? true : false : false; }[keyof M] extends true ? true : false;
/**
 * True if the mapping M pairs every key of A with exactly one key of B, and vice versa.
 * Every key of A being mapped is already guaranteed by the `Record<keyof A, keyof B>` constraint.
 */
type IsBijective<A extends object, B extends object, M extends Record<keyof A, keyof B>> = IsSurjective<B, M> extends true ? IsInjective<M> : false;
interface LilypadSerializerConstructorOptions<FROM extends object, TO extends object, KeyMap extends Record<keyof FROM, keyof TO>> {
  serialization: { [K in keyof FROM]: {
    target: IsBijective<FROM, TO, KeyMap> extends true ? KeyMap[K] : never;
    serialize: (item: FROM) => TO[KeyMap[K]];
    deserialize: (item: TO) => FROM[K];
    default: FROM[K];
    equality?: (value: FROM[K], defaultValue: FROM[K]) => boolean;
  }; };
}
/**
 * A generic serializer/deserializer for mapping objects between two shapes (`FROM` and `TO`)
 * using customizable key mappings, serialization, and deserialization functions.
 *
 * @typeParam FROM - The source object type to serialize from.
 * @typeParam TO - The target object type to serialize to.
 * @typeParam KeyMap - A mapping from keys in `FROM` to keys in `TO`.
 *
 * @remarks
 * - Each key of the source is mapped to its `target` key in the target object; the mapping must be
 *   bijective, otherwise `target` is typed as `never`.
 * - Custom serialization and deserialization functions can be provided for each key.
 * - Default values and equality checks can be specified to skip serialization of default values.
 * - When a function in the serialization map returns `undefined`, that key is omitted from the serialized output.
 * - When deserialization returns `undefined`, the key gets a copy of its default value (object
 *   defaults are cloned, so deserialized items never share them). `null` is kept as a value.
 *
 * @example
 * ```typescript
 * interface Source { a: number; b: string; }
 * interface Target { x: number; y: string; }
 * const serializer = new LilypadSerializer<Source, Target, { a: 'x'; b: 'y' }>({
 *   serialization: {
 *     a: { target: 'x', serialize: (item) => item.a, deserialize: (item) => item.x, default: 0 },
 *     b: { target: 'y', serialize: (item) => item.b, deserialize: (item) => item.y, default: '' },
 *   },
 * });
 * const packed = serializer.serialize([{ a: 1, b: 'foo' }]);
 * const unpacked = serializer.deserialize(packed);
 * ```
 */
declare class LilypadSerializer<FROM extends object, TO extends object, KeyMap extends Record<keyof FROM, keyof TO>> {
  private options;
  private readonly fromKeys;
  constructor(options: LilypadSerializerConstructorOptions<FROM, TO, KeyMap>);
  serialize(input: FROM[]): TO[];
  deserialize(input: TO[]): FROM[];
}
//#endregion
export { LilypadSerializerConstructorOptions as n, LilypadSerializer as t };
//# sourceMappingURL=serializer-KY78osoX.d.cts.map