// Lossless parsing — the single definition of how a JSON number literal becomes
// a value in this codebase. Pure module so the worker, the MCP server and the
// converter engine all parse identically; a second copy of this predicate would
// be a second answer to "did the digits change?", which is the one promise the
// tool makes.

import { parse as llParse, LosslessNumber } from 'lossless-json';

// Box a number whenever its canonical float form is not byte-identical to the
// source literal — everything else stays a native number so the parsed tree
// isn't bloated with wrappers. The obvious library predicate,
// isSafeNumber(v, {approx: false}), compares *significant* digits, so '88.10'
// passed as "safe" and every canonical copy silently became 88.1; trailing
// zeros, '-0', '1e3' and '0.0000005' are formatting the author chose, and this
// tool's one promise is that not a single digit changes. String(f) also rejects
// everything isSafeNumber rejected (a differing significant digit is in
// particular a differing byte), so this boxes strictly more, never less.
export const numberParser = (v: string): unknown => {
  const f = parseFloat(v);
  return String(f) === v ? f : new LosslessNumber(v);
};

export function lparse(text: string): unknown {
  return llParse(text, undefined, numberParser as never);
}
