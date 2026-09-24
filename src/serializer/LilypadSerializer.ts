type InvertRecord<R extends Record<PropertyKey, PropertyKey>> = {
  [K in keyof R as R[K]]: K;
};

/** True if every key of B is the target of at least one key of the mapping. */
type IsSurjective<
  B extends object,
  M extends Record<PropertyKey, PropertyKey>,
> = keyof B extends M[keyof M] ? true : false;

/** True if no two keys of the mapping have the same target. */
type IsInjective<M extends Record<PropertyKey, PropertyKey>> = {
  // InvertRecord<M>[M[K]] is the union of all the keys mapped to M[K]: it must be K alone
  [K in keyof M]: M[K] extends keyof InvertRecord<M>
    ? [InvertRecord<M>[M[K]]] extends [K]
      ? true
      : false
    : false;
}[keyof M] extends true
  ? true
  : false;

/**
 * True if the mapping M pairs every key of A with exactly one key of B, and vice versa.
 * Every key of A being mapped is already guaranteed by the `Record<keyof A, keyof B>` constraint.
 */
type IsBijective<A extends object, B extends object, M extends Record<keyof A, keyof B>> =
  IsSurjective<B, M> extends true ? IsInjective<M> : false;

export interface LilypadSerializerConstructorOptions<
  FROM extends object,
  TO extends object,
  KeyMap extends Record<keyof FROM, keyof TO>,
> {
  serialization: {
    [K in keyof FROM]: {
      target: IsBijective<FROM, TO, KeyMap> extends true ? KeyMap[K] : never;
      serialize: (item: FROM) => TO[KeyMap[K]];
      deserialize: (item: TO) => FROM[K];
      default: FROM[K];
      equality?: (value: FROM[K], defaultValue: FROM[K]) => boolean;
    };
  };
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
 * - When deserialization returns `null` or `undefined`, the key gets a copy of its default value
 *   (object defaults are cloned, so deserialized items never share them).
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
export class LilypadSerializer<
  FROM extends {},
  TO extends {},
  KeyMap extends Record<keyof FROM, keyof TO>,
> {
  constructor(private options: LilypadSerializerConstructorOptions<FROM, TO, KeyMap>) {}

  serialize(input: FROM[]): TO[] {
    return input.map((item) => {
      const packedItem = {} as TO;
      (Object.keys(this.options.serialization) as (keyof FROM)[]).forEach((fromKey) => {
        const isEqual = this.options.serialization[fromKey].equality ?? ((v, d) => v === d); // Fallback to strict equality
        if (isEqual(item[fromKey], this.options.serialization[fromKey].default)) {
          return; // Skip default values
        }

        const value = this.options.serialization[fromKey].serialize(item);
        if (value === undefined) {
          return; // Skip undefined serialization results
        }

        const toKey = this.options.serialization[fromKey].target;
        packedItem[toKey] = value as TO[typeof toKey];
      });
      return packedItem;
    });
  }

  deserialize(input: TO[]): FROM[] {
    return input.map((item) => {
      const unpackedItem = {} as FROM;
      (Object.keys(this.options.serialization) as (keyof FROM)[]).forEach((fromKey) => {
        unpackedItem[fromKey] =
          this.options.serialization[fromKey].deserialize(item) ??
          cloneDefault(this.options.serialization[fromKey].default);
      });
      return unpackedItem;
    });
  }
}

/**
 * Object defaults are cloned, otherwise every deserialized item would share (and could mutate)
 * the same default instance.
 */
function cloneDefault<T>(value: T): T {
  return typeof value === 'object' && value !== null ? structuredClone(value) : value;
}
