// A CSV conversion always comes back as a zip, because the CSV writer emits one
// file per table and a zip is how several files travel as one download. When
// the mapping produced a single table that reasoning stops applying: the person
// asked for a spreadsheet and is handed an archive they have to unpack before
// they can double-click anything. The shell opens that one case on the way out.
//
// Reading the archive back is a slice rather than a decompression because the
// writer stores its entries instead of deflating them (SPEC-converter §11).
// Anything that is not exactly that shape — more than one file, a compressed
// file, a trailing comment, a truncated buffer — returns null and travels on as
// the zip it already is. Guessing wrong here would hand someone a file that
// does not open, which is worse than one extra unpack.

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const LOCAL_HEADER = 0x04034b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const END_SIZE = 22; // with no archive comment, which is the only shape written here
const LOCAL_SIZE = 30;
// Two flags make the header untrustworthy: an encrypted file is not its bytes,
// and bit 3 says the real sizes arrive in a trailer after the data. Every other
// flag — including the UTF-8 one the writer sets on names — is fine here.
const UNREADABLE_FLAGS = 0x0001 | 0x0008;

/** The single stored file inside a zip, or null if it is not that. */
export function onlyStoredZipEntry(zip: Uint8Array): ZipEntry | null {
  if (zip.length < LOCAL_SIZE + END_SIZE) return null;
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - END_SIZE;

  if (view.getUint32(end, true) !== END_OF_CENTRAL_DIRECTORY) return null;
  if (view.getUint16(end + 8, true) !== 1) return null; // files on this disk
  if (view.getUint16(end + 10, true) !== 1) return null; // files in total
  if (view.getUint16(end + 20, true) !== 0) return null; // archive comment

  if (view.getUint32(0, true) !== LOCAL_HEADER) return null;
  if (view.getUint16(6, true) & UNREADABLE_FLAGS) return null;
  if (view.getUint16(8, true) !== 0) return null; // method: stored only
  const stored = view.getUint32(18, true);
  if (stored !== view.getUint32(22, true)) return null; // stored, so the two sizes agree
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const from = LOCAL_SIZE + nameLength + extraLength;
  if (from + stored > end) return null;

  return {
    name: new TextDecoder().decode(zip.subarray(LOCAL_SIZE, LOCAL_SIZE + nameLength)),
    bytes: zip.slice(from, from + stored),
  };
}
