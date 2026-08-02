// Document intake rules shared by every host: the browser app, and the MCP
// server that runs the same engine under Node. Nothing here touches the DOM, so
// both can import it and a document is admitted (or refused) on identical terms.

import type { PayloadTextSniff } from './codec';

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// The engine holds the fully materialized object graph (~4-6x the text size in
// heap), so past this point a host is headed for OOM, not slowness. Refuse with
// an honest message instead of crashing. Length is UTF-16 code units, which for
// JSON (overwhelmingly ASCII) tracks bytes closely enough for a guard.
export const MAX_DOC_BYTES = 200 * 1024 * 1024;

export function oversizeMessage(size: number): string {
  return `this document is ${fmtBytes(size)} — beyond the ~${fmtBytes(MAX_DOC_BYTES)} a browser tab can hold as live objects. Extract the part you need (e.g. with jq) and open that instead.`;
}

/** Raw `.zst` frame magic — such bytes must never go through a text decoder. */
export function hasRawZstdMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 &&
    bytes[0] === 0x28 &&
    bytes[1] === 0xb5 &&
    bytes[2] === 0x2f &&
    bytes[3] === 0xfd;
}

/** True when the sniffed text is a transport envelope rather than plain JSON. */
export function payloadSniffNeedsDecode(sniff: PayloadTextSniff): boolean {
  return sniff.recognized && (sniff.format !== 'json-text' || sniff.wrapper !== 'none');
}
