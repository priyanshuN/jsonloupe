// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
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

// RFC 8259 permits a repeated name, and JSON.parse, jq and the codec's own
// isValidJsonText keep the last value. lossless-json's default throws instead,
// which refused whole documents (and every JSONL file with one such line) that
// the validator had just called valid.
const keepLastDuplicate = ({ newValue }: { newValue: unknown }): unknown => newValue;

/**
 * Parse with the shared number predicate. The worker passes its own wrapper of
 * that predicate (it records unsafe numbers); everything else uses the default.
 */
export function lparse(text: string, parseNumber: (v: string) => unknown = numberParser): unknown {
  const value = llParse(text, undefined, { parseNumber: parseNumber as never, onDuplicateKey: keepLastDuplicate });
  return mayNameProto(text) ? restoreProtoMembers(value, JSON.parse(text)) : value;
}

// lossless-json up to 4.3.1 builds each object as `{}` and assigns
// `object[key] = value`, so a "__proto__" member runs Object.prototype's
// setter: an object value becomes the object's prototype (its fields then
// read as the document's own) and a scalar is dropped. JSON.parse, and
// lossless-json from 4.3.2, define the member as an own property.
// Only text that can spell that key pays for the repair: the literal
// `"__proto__"`, or a \u escape of one of its characters.
function mayNameProto(text: string): boolean {
  return text.includes('"__proto__"') || (text.includes('\\u00') && /\\u00(?:5[fF]|6[fF]|7[024])/.test(text));
}

/**
 * Walk the lossless tree beside JSON.parse's tree of the same text, which has
 * the same shape apart from "__proto__" members, and rebuild every object in
 * JSON.parse's key order, so the ones that should own such a member do.
 */
function restoreProtoMembers(value: unknown, plain: unknown): unknown {
  if (plain === null || typeof plain !== 'object') return value;
  if (Array.isArray(plain)) {
    const array = value as unknown[];
    for (let i = 0; i < plain.length; i++) array[i] = restoreProtoMembers(array[i], plain[i]);
    return array;
  }
  const object = value as Record<string, unknown>;
  const source = plain as Record<string, unknown>;
  // An own "__proto__" means the library defined the member itself (4.3.2
  // on), so its value is the lossless one; JSON.parse's copy would round a
  // boxed number. Otherwise the setter kept an object, array, null or boxed
  // number as the prototype, and dropped a string, boolean or native number,
  // which JSON.parse already holds exactly (a native number is one whose
  // float form IS its spelling).
  const prototype: unknown = Object.getPrototypeOf(object);
  // Object.fromEntries defines each member as an own data property, as
  // JSON.parse does, so a "__proto__" entry never reaches the setter. Every
  // object is rebuilt rather than written into, even one with no such member:
  // its keys come from the document, and a write by a document-chosen key is
  // the very setter this undoes. Only text mayNameProto lets through pays.
  return Object.fromEntries(
    Object.keys(source).map((key) => {
      const member =
        key !== '__proto__' || Object.hasOwn(object, key)
          ? object[key]
          : prototype === Object.prototype
            ? source[key]
            : prototype;
      return [key, restoreProtoMembers(member, source[key])];
    }),
  );
}
