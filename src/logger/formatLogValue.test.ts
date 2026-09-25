import { describe, it, expect } from 'vitest';
import { formatLogValue } from './formatLogValue';

describe('formatLogValue', () => {
  it.each([
    ['plain strings as they are', 'hello', 'hello'],
    ['numbers', 42, '42'],
    ['BigInts', 10n, '10n'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['symbols', Symbol('s'), 'Symbol(s)'],
    ['functions', function named() {}, '[Function: named]'],
    ['nested strings quoted', { a: "it's" }, "{ a: 'it\\'s' }"],
    ['objects', { key: 'value', n: 1 }, "{ key: 'value', n: 1 }"],
    ['keys that are not identifiers', { 'a-b': 1 }, "{ 'a-b': 1 }"],
    ['empty objects and arrays', [{}, []], '[ {}, [] ]'],
    ['arrays', [1, 'two'], "[ 1, 'two' ]"],
    ['dates', new Date('2026-01-02T03:04:05.000Z'), '2026-01-02T03:04:05.000Z'],
    ['maps', new Map([['k', 1]]), "Map(1) { 'k' => 1 }"],
    ['sets', new Set([1]), 'Set(1) { 1 }'],
  ])('should format %s', (_name, value, expected) => {
    expect(formatLogValue(value)).toBe(expected);
  });

  it('should keep the stack and the cause of errors', () => {
    const error = new Error('outer', { cause: new Error('inner') });

    const formatted = formatLogValue(error);

    expect(formatted).toContain('Error: outer');
    expect(formatted).toContain('formatLogValue.test.ts');
    expect(formatted).toContain('[cause]: Error: inner');
  });

  it('should mark circular references', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(formatLogValue(circular)).toBe("{ name: 'loop', self: [Circular] }");
  });

  it('should not mark a value seen twice without a cycle as circular', () => {
    const shared = { v: 1 };

    expect(formatLogValue({ a: shared, b: shared })).toBe('{ a: { v: 1 }, b: { v: 1 } }');
  });

  it('should abbreviate objects nested deeper than 4 levels', () => {
    expect(formatLogValue({ a: { b: { c: { d: { e: 1 } } } } })).toBe(
      '{ a: { b: { c: { d: [Object] } } } }'
    );
  });
});
