import { describe, it, expect } from 'vitest';
import { assertNumberOption } from './LilypadValidation';

describe('assertNumberOption', () => {
  it.each([
    [1, 'positive'],
    [0, 'non-negative'],
    [3, 'positive-integer'],
    [0, 'non-negative-integer'],
    [undefined, 'positive'],
  ] as const)('should accept %s as %s', (value, rule) => {
    expect(() => assertNumberOption('Owner', 'option', value, rule)).not.toThrow();
  });

  it.each([
    [0, 'positive'],
    [Number.NaN, 'positive'],
    [Infinity, 'positive'],
    [-1, 'non-negative'],
    [Number.NaN, 'non-negative'],
    [1.5, 'positive-integer'],
    [Infinity, 'positive-integer'],
    [-1, 'non-negative-integer'],
    [0.5, 'non-negative-integer'],
  ] as const)('should reject %s as %s', (value, rule) => {
    expect(() => assertNumberOption('Owner', 'option', value, rule)).toThrow(
      /^Owner: option must be/
    );
  });
});
