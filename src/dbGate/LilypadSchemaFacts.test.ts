import { describe, it, expect } from 'vitest';
import { decodeLilypadTriggerArgs } from './LilypadSchemaFacts';

describe('decodeLilypadTriggerArgs', () => {
  it.each<[string, string[]]>([
    ['', []],
    ['id\\000', ['id']],
    ['id\\000other\\000', ['id', 'other']],
    // The bytes of UTF-8 beyond ASCII are octal escapes
    ['cl\\303\\251\\000', ['clé']],
    ['\\346\\227\\245\\000', ['日']],
    // A backslash is doubled
    ['a\\\\b\\000', ['a\\b']],
  ])('should decode %j', (escaped, expected) => {
    expect(decodeLilypadTriggerArgs(escaped)).toEqual(expected);
  });
});
