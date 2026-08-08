// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  bestSource,
  ceilingBreaches,
  csvCaution,
  csvHeader,
  dateInputValue,
  errorTarget,
  fieldHint,
  friendlyPath,
  joinList,
  outcomeLine,
  presenceText,
} from './convert-view';

describe('converter mapping helpers', () => {
  it('reads a CSV target header including quoted commas and escaped quotes', () => {
    expect(csvHeader('\uFEFFreference_number,"Address, line 1","say ""yes"""\r\n1,2,3')).toEqual([
      'reference_number',
      'Address, line 1',
      'say "yes"',
    ]);
  });

  it('refuses an unterminated quoted target header', () => {
    expect(() => csvHeader('id,"address')).toThrow(/unclosed quoted header/);
  });

  it('matches target names to current or ancestor source fields', () => {
    const candidates = ['orderId', 'customer_name', '^.dispatchDate'];
    expect(bestSource('Order ID', candidates)).toBe('orderId');
    expect(bestSource('dispatch date', candidates)).toBe('^.dispatchDate');
    expect(bestSource('unrelated', candidates)).toBeUndefined();
  });

  it('keeps path grammar out of the visible table location', () => {
    expect(friendlyPath('$.orders[].items[]')).toBe('orders › items');
  });

  it('formats the local calendar date for time-only mappings', () => {
    expect(dateInputValue(new Date(2026, 7, 8, 23, 30))).toBe('2026-08-08');
  });
});

describe('the line the panel opens with', () => {
  // The panel arrives with the mapping drafted and the download live, so its
  // first line has to be an outcome. A bare table count reads as a form.
  it('names what comes out, how big it is, and that nothing else is required', () => {
    expect(outcomeLine({ tables: 2, rows: 1204, format: 'xlsx', problems: 0 }))
      .toBe('Ready — 2 sheets, 1,204 rows. Download, or change anything below.');
  });

  it('calls the outputs files rather than sheets once CSV is chosen', () => {
    expect(outcomeLine({ tables: 1, rows: 1, format: 'csv', problems: 0 }))
      .toBe('Ready — 1 file, 1 row. Download, or change anything below.');
  });

  // Saying "ready" over a mapping the engine has already refused would be the
  // one lie this line could tell, so a problem count replaces it outright.
  it('refuses to say ready while the mapping has problems', () => {
    expect(outcomeLine({ tables: 2, rows: 1204, format: 'xlsx', problems: 3 }))
      .toBe('Not ready — 3 problems to fix, marked below.');
  });
});

describe('what CSV costs this particular document', () => {
  // The hazards are read off the previewed cells, so the sentence names this
  // document's columns. A general warning about CSV teaches nobody which of
  // their columns is at risk.
  it('names the columns a spreadsheet would re-read on the way back in', () => {
    const caution = csvCaution([{
      columns: ['order_id', 'postcode', 'city'],
      rows: [['9780306406157012', '00791', 'York']],
    }]);
    expect(caution).toContain('long numbers in order_id');
    expect(caution).toContain('leading zeros in postcode');
    expect(caution).not.toContain('city');
  });

  it('counts the columns past the second rather than listing all of them', () => {
    const caution = csvCaution([{
      columns: ['a', 'b', 'c', 'd'],
      rows: [['01', '02', '03', '04']],
    }]);
    expect(caution).toContain('leading zeros in a, b and 2 more');
  });

  it('flags accented text, which survives the export and not always the reader', () => {
    expect(csvCaution([{ columns: ['name'], rows: [['Zoë']] }]))
      .toContain('accented text in name');
  });

  // A caution with nothing to caution about must not invent one — the CSV
  // branch still has to say what CSV is.
  it('says what CSV is when this document holds nothing at risk', () => {
    const caution = csvCaution([{ columns: ['id', 'city'], rows: [['7', 'York']] }]);
    expect(caution).toContain('one file per table');
    expect(caution).not.toContain('can come back changed');
  });
});

describe('the ceilings a spreadsheet will refuse at', () => {
  const fits = { columns: ['a'], total: 10, widest: { column: 'a', chars: 12 } };

  it('stays quiet about a table that fits', () => {
    expect(ceilingBreaches(fits)).toEqual([]);
  });

  // Naming the column is the whole point: "a cell is too long" sends the user
  // hunting through every column they have.
  it('names the column whose longest value will not fit in a cell', () => {
    const said = ceilingBreaches({ ...fits, widest: { column: 'notes', chars: 40000 } });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('notes is too long for one cell');
    expect(said[0]).toContain('40,000 characters of 32,767');
  });

  // Grouped through toLocaleString, as every other figure in this view is, so
  // the expectation is built the same way rather than pinned to one locale.
  it('reports a row count past what one sheet holds', () => {
    expect(ceilingBreaches({ ...fits, total: 2_000_000 })[0])
      .toBe(`too many rows for one sheet — ${(2_000_000).toLocaleString()}`
        + ` of ${(1_048_576).toLocaleString()}`);
  });
});

describe('routing a problem to the row it belongs to', () => {
  it('reads the table and column a validation error was addressed to', () => {
    expect(errorTarget('tables[1].columns[3].from')).toEqual({ table: 1, column: 3 });
  });

  // A table-level problem — a bad anchor, a parent link to a table that is gone
  // — names no column, and must not be pinned to whichever column sits at 0.
  it('leaves a table-level problem unattached to any column', () => {
    expect(errorTarget('tables[0].anchor')).toEqual({ table: 0, column: null });
  });

  it('gives up on an address it does not recognise, rather than guessing', () => {
    expect(errorTarget('output.onMissing')).toBeNull();
  });
});

describe('showing what is in a field', () => {
  it('says how often a field is filled and what it looks like', () => {
    expect(fieldHint(50, 50, false, ['ACME', 'Globex'])).toBe('in every row · ACME, Globex');
    expect(fieldHint(12, 50, false, ['7'])).toBe('in 24% of rows · 7');
  });

  // Detection reads the head of a big table, so quoting a share against the
  // whole document would be a figure nobody can check.
  it('admits when the share is over the rows detection actually read', () => {
    expect(presenceText(2000, 2000, true)).toBe('in all of the first 2,000 rows');
    expect(presenceText(1000, 2000, true)).toBe('in 50% of the first 2,000 rows');
  });

  it('never rounds a field that is present somewhere down to nothing', () => {
    expect(presenceText(1, 5000)).toBe('in 1% of rows');
  });

  it('keeps a long sample from swamping the row it describes', () => {
    expect(fieldHint(1, 1, false, ['x'.repeat(40)])).toBe(`in every row · ${'x'.repeat(23)}…`);
  });
});

describe('lists read as sentences', () => {
  it('joins with and rather than trailing commas', () => {
    expect(joinList(['a'])).toBe('a');
    expect(joinList(['a', 'b'])).toBe('a and b');
    expect(joinList(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
