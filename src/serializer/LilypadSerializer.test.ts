import { describe, it, expect } from 'vitest';
import { LilypadSerializer } from './LilypadSerializer';

describe('LilypadSerializer', () => {
  interface Source {
    id: number;
    name: string;
    active: boolean;
  }

  interface Target {
    userId: number;
    userName: string;
    isActive: boolean;
  }

  type StringWrapper = {
    value: string;
  };
  type NumberWrapper = {
    value: number;
  };
  interface InvertedTarget {
    isActive: boolean;
    userName: StringWrapper;
    userId: NumberWrapper;
  }

  //const test = { id: 'userId', name: 'userName', active: 'isActive' };

  const createSerializer = () =>
    new LilypadSerializer<Source, Target, { id: 'userId'; name: 'userName'; active: 'isActive' }>({
      serialization: {
        id: {
          target: 'userId',
          serialize: (item) => item.id,
          deserialize: (item) => item.userId,
          default: 0,
        },
        name: {
          target: 'userName',
          serialize: (item) => item.name,
          deserialize: (item) => item.userName,
          default: '',
        },
        active: {
          target: 'isActive',
          serialize: (item) => item.active,
          deserialize: (item) => item.isActive,
          default: false,
        },
      },
    });

  describe('serialize', () => {
    it('should serialize objects with key mapping', () => {
      const serializer = createSerializer();
      const input: Source[] = [{ id: 1, name: 'John', active: true }];
      const result = serializer.serialize(input);

      expect(result).toEqual([{ userId: 1, userName: 'John', isActive: true }]);
    });

    it('should skip default values', () => {
      const serializer = createSerializer();
      const input: Source[] = [{ id: 0, name: '', active: false }];
      const result = serializer.serialize(input);

      expect(result).toEqual([{}]);
    });

    it('should skip undefined serialization results', () => {
      const serializer = new LilypadSerializer<
        Source,
        Target,
        { id: 'userId'; name: 'userName'; active: 'isActive' }
      >({
        serialization: {
          id: {
            target: 'userId',
            serialize: () => undefined as unknown as number,
            deserialize: (item) => item.userId,
            default: 0,
          },
          name: {
            target: 'userName',
            serialize: (item) => item.name,
            deserialize: (item) => item.userName,
            default: '',
          },
          active: {
            target: 'isActive',
            serialize: (item) => item.active,
            deserialize: (item) => item.isActive,
            default: false,
          },
        },
      });
      const input: Source[] = [{ id: 1, name: 'John', active: true }];
      const result = serializer.serialize(input);

      expect(result).toEqual([{ userName: 'John', isActive: true }]);
    });

    it('should use custom equality map', () => {
      const serializer = new LilypadSerializer<
        Source,
        Target,
        { id: 'userId'; name: 'userName'; active: 'isActive' }
      >({
        serialization: {
          id: {
            target: 'userId',
            serialize: (item) => item.id,
            deserialize: (item) => item.userId,
            default: 0,
          },
          name: {
            target: 'userName',
            serialize: (item) => item.name,
            deserialize: (item) => item.userName,
            equality: (v, d) => v.length === d.length,
            default: 'aa',
          },
          active: {
            target: 'isActive',
            serialize: (item) => item.active,
            deserialize: (item) => item.isActive,
            default: false,
          },
        },
      });
      const input: Source[] = [{ id: 1, name: 'ab', active: true }];
      const result = serializer.serialize(input);

      expect(result).toEqual([{ userId: 1, isActive: true }]);
    });
  });

  describe('deserialize', () => {
    it('should deserialize objects with key mapping', () => {
      const serializer = createSerializer();
      const input: Target[] = [{ userId: 1, userName: 'John', isActive: true }];
      const result = serializer.deserialize(input);

      expect(result).toEqual([{ id: 1, name: 'John', active: true }]);
    });

    it('should use default values for missing keys', () => {
      const serializer = createSerializer();
      const input: Target[] = [{ userId: 1 } as Target];
      const result = serializer.deserialize(input);

      expect(result).toEqual([{ id: 1, name: '', active: false }]);
    });
  });

  describe('round-trip', () => {
    it('should serialize and deserialize correctly', () => {
      const serializer = createSerializer();
      const original: Source[] = [{ id: 42, name: 'Alice', active: true }];
      const serialized = serializer.serialize(original);
      const deserialized = serializer.deserialize(serialized);

      expect(deserialized).toEqual(original);
    });

    it('should handle default values in round-trip', () => {
      const serializer = createSerializer();
      const original: Source[] = [{ id: 0, name: '', active: true }];
      const serialized = serializer.serialize(original);

      expect(serialized).toEqual([{ isActive: true }]);

      const deserialized = serializer.deserialize(serialized);

      expect(deserialized).toEqual(original);
    });
  });

  describe('should handle type-inverted key mappings', () => {
    it('should serialize and deserialize with inverted types', () => {
      const serializer = new LilypadSerializer<
        Source,
        InvertedTarget,
        { id: 'userId'; name: 'userName'; active: 'isActive' }
      >({
        serialization: {
          id: {
            target: 'userId',
            serialize: (item) => ({ value: item.id }),
            deserialize: (item) => item.userId.value,
            default: 0,
          },
          name: {
            target: 'userName',
            serialize: (item) => ({ value: item.name }),
            deserialize: (item) => item.userName.value,
            default: '',
          },
          active: {
            target: 'isActive',
            serialize: (item) => item.active,
            deserialize: (item) => item.isActive,
            default: false,
          },
        },
      });

      const original: Source[] = [{ id: 7, name: 'Bob', active: false }];
      const serialized = serializer.serialize(original);
      expect(serialized).toEqual([{ userId: { value: 7 }, userName: { value: 'Bob' } }]);

      const deserialized = serializer.deserialize(serialized);
      expect(deserialized).toEqual(original);
    });

    it('should handle multiple objects in serialization', () => {
      const serializer = createSerializer();
      const input: Source[] = [
        { id: 1, name: 'Alice', active: true },
        { id: 2, name: 'Bob', active: false },
        { id: 0, name: '', active: true },
      ];
      const result = serializer.serialize(input);

      expect(result).toEqual([
        { userId: 1, userName: 'Alice', isActive: true },
        { userId: 2, userName: 'Bob' },
        { isActive: true },
      ]);
    });

    it('should handle empty arrays', () => {
      const serializer = createSerializer();
      const input: Source[] = [];
      const result = serializer.serialize(input);

      expect(result).toEqual([]);
    });

    it('should handle multiple objects in deserialization', () => {
      const serializer = createSerializer();
      const input: Target[] = [
        { userId: 1, userName: 'Alice', isActive: true },
        { userId: 2, userName: 'Bob', isActive: false },
      ];
      const result = serializer.deserialize(input);

      expect(result).toEqual([
        { id: 1, name: 'Alice', active: true },
        { id: 2, name: 'Bob', active: false },
      ]);
    });
  });

  describe('defaults', () => {
    it('should not share object defaults between deserialized items', () => {
      interface Tagged {
        tags: string[];
      }
      interface PackedTagged {
        t?: string[];
      }
      const serializer = new LilypadSerializer<Tagged, PackedTagged, { tags: 't' }>({
        serialization: {
          tags: {
            target: 't',
            serialize: (item) => item.tags,
            deserialize: (item) => item.t as string[],
            default: [],
          },
        },
      });

      const [first, second] = serializer.deserialize([{}, {}]);
      first.tags.push('mutated');

      expect(second.tags).toEqual([]);
    });
  });

  // These cases are checked at compile time by `npm run typecheck`: an unused @ts-expect-error fails it
  describe('key mapping type checks', () => {
    it('should reject key mappings that are not injective', () => {
      interface TwoKeys {
        a: number;
        b: number;
      }
      interface OneKey {
        x: number;
      }
      const create = () =>
        new LilypadSerializer<TwoKeys, OneKey, { a: 'x'; b: 'x' }>({
          serialization: {
            a: {
              // @ts-expect-error 'a' and 'b' both map to 'x'
              target: 'x',
              serialize: (item) => item.a,
              deserialize: (item) => item.x,
              default: 0,
            },
            b: {
              // @ts-expect-error 'a' and 'b' both map to 'x'
              target: 'x',
              serialize: (item) => item.b,
              deserialize: (item) => item.x,
              default: 0,
            },
          },
        });
      expect(create).toBeTypeOf('function');
    });

    it('should reject key mappings that are not surjective', () => {
      interface OneKey {
        a: number;
      }
      interface TwoKeys {
        x: number;
        y: number;
      }
      const create = () =>
        new LilypadSerializer<OneKey, TwoKeys, { a: 'x' }>({
          serialization: {
            a: {
              // @ts-expect-error 'y' is not the target of any key
              target: 'x',
              serialize: (item) => item.a,
              deserialize: (item) => item.x,
              default: 0,
            },
          },
        });
      expect(create).toBeTypeOf('function');
    });
  });
});
