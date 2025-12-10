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

  const createSerializer = () =>
    new LilypadSerializer<Source, Target, { id: 'userId'; name: 'userName'; active: 'isActive' }>({
      keyMapping: { id: 'userId', name: 'userName', active: 'isActive' },
      fromDefaultValues: { id: 0, name: '', active: false },
      serializationMap: {
        id: (item) => item.id,
        name: (item) => item.name,
        active: (item) => item.active,
      },
      deserializationMap: {
        userId: (item) => item.userId,
        userName: (item) => item.userName,
        isActive: (item) => item.isActive,
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
        keyMapping: { id: 'userId', name: 'userName', active: 'isActive' },
        fromDefaultValues: { id: 0, name: '', active: false },
        serializationMap: {
          id: () => undefined as unknown as number,
          name: (item) => item.name,
          active: (item) => item.active,
        },
        deserializationMap: {
          userId: (item) => item.userId,
          userName: (item) => item.userName,
          isActive: (item) => item.isActive,
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
        keyMapping: { id: 'userId', name: 'userName', active: 'isActive' },
        fromDefaultValues: { id: 0, name: 'aa', active: false },
        equalityMap: { name: (v, d) => v.length === d.length },
        serializationMap: {
          id: (item) => item.id,
          name: (item) => item.name,
          active: (item) => item.active,
        },
        deserializationMap: {
          userId: (item) => item.userId,
          userName: (item) => item.userName,
          isActive: (item) => item.isActive,
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
  });
});
