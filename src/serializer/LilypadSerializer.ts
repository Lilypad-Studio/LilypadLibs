type InvertRecord<R extends Record<PropertyKey, PropertyKey>> = {
  [K in keyof R as R[K]]: K;
};

type InvertedKeyMap<
  FROM extends object,
  TO extends object,
  KeyMap extends Record<keyof FROM, keyof TO>,
> = {
  [K in keyof TO]: {
    [F in keyof FROM]: KeyMap[F] extends K ? F : never;
  }[keyof FROM];
};

type IsBijective<A extends object, B extends object, M extends Record<keyof A, keyof B>> =
  // Same number of keys
  keyof A extends keyof M
    ? keyof B extends M[keyof A]
      ? InvertRecord<M> extends Record<keyof B, keyof A>
        ? true
        : false
      : false
    : false;

export interface LilypadSerializerConstructorOptions<
  FROM extends object,
  TO extends object,
  KeyMap extends Record<keyof FROM, keyof TO>,
> {
  keyMapping: IsBijective<FROM, TO, KeyMap> extends true ? KeyMap : never;

  fromDefaultValues: { [K in keyof FROM]: FROM[K] };
  equalityMap?: {
    [K in keyof FROM]?: (value: FROM[K], defaultValue: FROM[K]) => boolean;
  };

  serializationMap: {
    [K in keyof FROM]: (item: FROM) => TO[KeyMap[K]];
  };

  deserializationMap: {
    [K in keyof TO]: (item: TO) => FROM[InvertedKeyMap<FROM, TO, KeyMap>[K]];
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
 * - The serializer uses a `keyMapping` to map keys from the source to the target object.
 * - Custom serialization and deserialization functions can be provided for each key.
 * - Default values and equality checks can be specified to skip serialization of default values.
 * - When a function in the serialization map returns `undefined`, that key is omitted from the serialized output.
 *
 * @example
 * ```typescript
 * interface Source { a: number; b: string; }
 * interface Target { x: number; y: string; }
 * const serializer = new LilypadSerializer<Source, Target, { a: 'x'; b: 'y' }>({
 *   keyMapping: { a: 'x', b: 'y' },
 *   serializationMap: { a: item => item.a, b: item => item.b },
 *   deserializationMap: { x: item => item.x, y: item => item.y },
 *   fromDefaultValues: { a: 0, b: '' }
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
      (Object.keys(this.options.keyMapping) as (keyof FROM)[]).forEach((fromKey) => {
        if (!this.options.serializationMap[fromKey]) {
          return; // Skip if no serialization function is provided
        }

        const isEqual = this.options.equalityMap?.[fromKey] ?? ((v, d) => v === d); // Fallback to strict equality
        if (isEqual(item[fromKey], this.options.fromDefaultValues[fromKey])) {
          return; // Skip default values
        }

        const value = this.options.serializationMap[fromKey](item);
        if (value === undefined) {
          return; // Skip undefined serialization results
        }

        const toKey = this.options.keyMapping[fromKey] as keyof TO;
        packedItem[toKey] = value;
      });
      return packedItem;
    });
  }

  deserialize(input: TO[]): FROM[] {
    return input.map((item) => {
      const unpackedItem = {} as FROM;
      (Object.keys(this.options.keyMapping) as (keyof FROM)[]).forEach((fromKey) => {
        const toKey = this.options.keyMapping[fromKey];
        // Use the unpacking function if the key exists, otherwise use the default value
        if (toKey in item) {
          unpackedItem[fromKey as keyof FROM] = this.options.deserializationMap[toKey](
            item
          ) as FROM[keyof FROM];
        } else {
          unpackedItem[fromKey as keyof FROM] = this.options.fromDefaultValues[fromKey];
        }
      });
      return unpackedItem;
    });
  }
}
