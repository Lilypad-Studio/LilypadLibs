import { describe, it, expect } from 'vitest';
import { lilypadNetChanges } from './LilypadChangelogSync';
import type { LilypadChange } from '@/dbGate/LilypadChangelog';

const change = (id: string, rowId: string | null, op: LilypadChange['op']) =>
  ({ id, xid: BigInt(id), rowId, op }) as LilypadChange;

describe('lilypadNetChanges', () => {
  it('should keep the last change of each row, in the order of the last changes', () => {
    const { truncated, rows } = lilypadNetChanges([
      change('1', 'a', 'INSERT'),
      change('2', 'b', 'UPDATE'),
      change('3', 'a', 'DELETE'),
    ]);

    expect(truncated).toBe(false);
    expect([...rows.values()].map(({ rowId, op }) => [rowId, op])).toEqual([
      ['b', 'UPDATE'],
      ['a', 'DELETE'],
    ]);
  });

  it('should drop the changes made before the last TRUNCATE', () => {
    const { truncated, rows } = lilypadNetChanges([
      change('1', 'a', 'UPDATE'),
      change('2', null, 'TRUNCATE'),
      change('3', 'b', 'INSERT'),
    ]);

    expect(truncated).toBe(true);
    expect([...rows.keys()]).toEqual(['b']);
  });
});
