import { describe, it, expect } from 'vitest';
import {
  isLilypadIntegerPgType,
  isLilypadSerialPgType,
  lilypadColumnTypeMismatch,
  lilypadColumnTypesOfPgType,
  normalizeLilypadPgType,
} from './LilypadPgTypes';

describe('lilypadColumnTypesOfPgType', () => {
  it.each([
    ['int4', ['number']],
    ['INTEGER', ['number']],
    ['double  precision', ['number']],
    ['serial', ['number']],
    ['int8', ['bigint', 'string']],
    ['bigserial', ['bigint', 'string']],
    ['numeric(10, 2)', ['string', 'bigint']],
    ['uuid', ['string']],
    ['varchar(64)', ['string']],
    ['character varying(64)', ['string']],
    ['time(3) with time zone', ['string']],
    ['timestamptz', ['date']],
    ['timestamp(3) with time zone', ['date']],
    ['timestamptz(3)', ['date']],
    ['date', ['date']],
    ['bool', ['boolean']],
    ['jsonb', ['json']],
    ['text[]', ['array']],
    ['user_role[]', ['array']],
  ])('should read %s as %j', (pgType, types) => {
    expect(lilypadColumnTypesOfPgType(pgType)).toEqual(types);
  });

  it.each(['user_role', 'public.citext', 'bytea', 'geometry', 'constructor', 'toString'])(
    'should not know %s',
    (pgType) => {
      expect(lilypadColumnTypesOfPgType(pgType)).toBeUndefined();
    }
  );
});

describe('normalizeLilypadPgType', () => {
  it.each([
    ['int4', 'integer'],
    ['INT', 'integer'],
    ['serial', 'integer'],
    ['bigserial', 'bigint'],
    ['int8[]', 'bigint[]'],
    ['bool', 'boolean'],
    ['varchar(64)', 'character varying(64)'],
    ['varchar', 'character varying'],
    ['char', 'character(1)'],
    ['numeric(10, 2)', 'numeric(10,2)'],
    ['decimal', 'numeric'],
    ['float8', 'double precision'],
    ['timestamptz', 'timestamp with time zone'],
    ['timestamptz(3)', 'timestamp(3) with time zone'],
    ['timestamp', 'timestamp without time zone'],
    ['timestamp(3) with time zone', 'timestamp(3) with time zone'],
    ['time', 'time without time zone'],
    ['timetz', 'time with time zone'],
    ['text[][]', 'text[][]'],
    ['uuid', 'uuid'],
    ['Public.CITEXT', 'public.citext'],
  ])('should read %s as %s', (declared, expected) => {
    expect(normalizeLilypadPgType(declared)).toBe(expected);
  });
});

describe('lilypadColumnTypeMismatch', () => {
  it('should give the fitting types of a known type, or of the category of an unknown one', () => {
    expect(lilypadColumnTypeMismatch('number', 'numeric(10,2)')).toEqual(['string', 'bigint']);
    expect(lilypadColumnTypeMismatch('string', 'int8')).toBeUndefined();
    expect(lilypadColumnTypeMismatch('date', 'time without time zone', 'D')).toEqual(['string']);
    expect(lilypadColumnTypeMismatch('number', 'app.mood', 'E')).toEqual(['string']);
    expect(lilypadColumnTypeMismatch('number', 'app.positive_int', 'N')).toBeUndefined();
    expect(lilypadColumnTypeMismatch('number', 'vector(3)', 'U')).toBeUndefined();
    expect(lilypadColumnTypeMismatch('number', 'mood')).toBeUndefined();
  });
});

describe('isLilypadSerialPgType and isLilypadIntegerPgType', () => {
  it('should tell the serial and the integer types', () => {
    expect(['serial', 'BIGSERIAL', 'serial2'].map(isLilypadSerialPgType)).toEqual([
      true,
      true,
      true,
    ]);
    expect(['int4', 'integer'].map(isLilypadSerialPgType)).toEqual([false, false]);
    expect(['int2', 'integer', 'int8', 'bigserial'].map(isLilypadIntegerPgType)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(['numeric', 'int4[]', 'text', 'mood'].map(isLilypadIntegerPgType)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
