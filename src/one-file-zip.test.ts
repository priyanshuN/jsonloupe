// The shell unpacks a one-table CSV result on the way to the download, so a
// person who converted one table double-clicks a spreadsheet instead of an
// archive. Getting that wrong hands them a file that does not open, so the
// reader is tested against the real writer rather than against a fixture: if
// the zip the converter produces ever stops matching what this reads, the
// result must fall back to the zip, and that is the case worth pinning.

import { describe, expect, it } from 'vitest';
import { zipTextFiles } from './convert/index';
import { onlyStoredZipEntry } from './one-file-zip';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('unwrapping a converter zip', () => {
  it('returns the single file byte-for-byte, under the name it had inside', () => {
    const text = 'orderId,reference\r\n7241590238164561921,SO-10428\r\n';
    const only = onlyStoredZipEntry(zipTextFiles([{ name: 'orders.csv', text }]));
    expect(only?.name).toBe('orders.csv');
    expect(decode(only!.bytes)).toBe(text);
  });

  it('survives a file whose text is not ASCII, where a byte count is not a character count', () => {
    const text = 'city\r\nMünchen — Bristol 🚚\r\n';
    const only = onlyStoredZipEntry(zipTextFiles([{ name: 'städte.csv', text }]));
    expect(only?.name).toBe('städte.csv');
    expect(decode(only!.bytes)).toBe(text);
  });

  it('refuses a result with more than one table — those only mean anything as a set', () => {
    const zip = zipTextFiles([
      { name: 'orders.csv', text: 'id\r\n1\r\n' },
      { name: 'order_items.csv', text: 'order_id,sku\r\n1,A\r\n' },
    ]);
    expect(onlyStoredZipEntry(zip)).toBeNull();
  });

  it('refuses an empty archive rather than inventing a file', () => {
    expect(onlyStoredZipEntry(zipTextFiles([]))).toBeNull();
  });

  it('refuses anything that is not the archive this app writes', () => {
    const zip = zipTextFiles([{ name: 'orders.csv', text: 'id\r\n1\r\n' }]);

    // A compressed entry: the bytes would be deflate output, not the CSV.
    const deflated = zip.slice();
    deflated[8] = 8; // local header, compression method
    expect(onlyStoredZipEntry(deflated)).toBeNull();

    // Sizes carried in a trailer after the data (general purpose flag bit 3),
    // which means the header's lengths cannot be trusted.
    const trailing = zip.slice();
    trailing[6] = 0x08;
    expect(onlyStoredZipEntry(trailing)).toBeNull();

    // Not a zip at all, and a buffer too short to hold one.
    expect(onlyStoredZipEntry(new TextEncoder().encode('id\r\n1\r\n'))).toBeNull();
    expect(onlyStoredZipEntry(new Uint8Array(0))).toBeNull();
  });
});
