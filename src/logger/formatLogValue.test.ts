import { describe, it, expect } from 'vitest';
import { formatLogValue, toLogJson } from './formatLogValue';

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

describe('formatLogValue robustness', () => {
  it('should print the own properties of errors, such as the code of a database error', () => {
    const error = Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (id)=(1) already exists.',
    });

    const formatted = formatLogValue(error);

    expect(formatted).toContain('Error: duplicate key');
    expect(formatted).toContain("{ code: '23505', detail: 'Key (id)=(1) already exists.' }");
  });

  it('should not repeat the name of errors that set it as an own property', () => {
    class CustomError extends Error {
      constructor() {
        super('custom');
        this.name = 'CustomError';
      }
    }

    expect(formatLogValue(new CustomError())).not.toContain("name: 'CustomError'");
  });

  it('should keep formatting when a getter throws', () => {
    const value = {
      ok: 1,
      get broken(): number {
        throw new Error('boom');
      },
    };
    Object.defineProperty(value, 'broken', { enumerable: true });

    expect(formatLogValue(value)).toBe('{ ok: 1, broken: [Getter threw] }');
  });

  it('should never throw, even for a Proxy whose traps throw', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap');
        },
      }
    );

    expect(formatLogValue(hostile)).toBe('[Unformattable value]');
  });
});

describe('toLogJson', () => {
  it('should redact at any depth, also inside errors and what toJSON returns', () => {
    const error = Object.assign(new Error('request failed'), {
      config: { headers: { Authorization: 'Bearer secret' } },
      cause: new Error('socket closed'),
    });
    const json = toLogJson({
      error,
      request: { toJSON: () => ({ headers: { cookie: 'sid=1' }, url: '/users' }) },
    }) as Record<string, Record<string, unknown>>;

    expect(JSON.stringify(json)).not.toContain('secret');
    expect(json.error).toMatchObject({
      name: 'Error',
      message: 'request failed',
      config: { headers: { Authorization: '[Redacted]' } },
      cause: { message: 'socket closed' },
    });
    expect(json.request).toEqual({ headers: { cookie: '[Redacted]' }, url: '/users' });
  });

  it('should turn what JSON cannot hold into plain values', () => {
    const node: Record<string, unknown> = { big: 10n, at: new Date(0), invalid: new Date(NaN) };
    node.self = node;
    node.map = new Map<unknown, unknown>([
      ['token', 'secret'],
      [1, 'one'],
    ]);
    node.set = new Set(['a']);

    expect(toLogJson(node)).toEqual({
      big: '10n',
      at: '1970-01-01T00:00:00.000Z',
      invalid: null,
      self: '[Circular]',
      map: { token: '[Redacted]', 1: 'one' },
      set: ['a'],
    });
  });

  it('should keep the depth the text form abbreviates', () => {
    const deep = { a: { b: { c: { d: { e: 'deep' } } } } };

    expect(formatLogValue(deep)).toBe('{ a: { b: { c: { d: [Object] } } } }');
    expect(toLogJson(deep)).toEqual(deep);
  });
});
