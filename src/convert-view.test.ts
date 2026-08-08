import { describe, expect, it } from 'vitest';
import { bestSource, csvHeader, dateInputValue, friendlyPath } from './convert-view';

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
