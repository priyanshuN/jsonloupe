// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
//
// Names what jsonrepair actually did, or says nothing. The badge's tooltip
// used to describe only the effect ("input was malformed and auto-repaired");
// this walks the original and repaired texts together, classifies each edit
// it can PROVE from the bytes, and returns a phrase like
// "added 1 quote pair · re-quoted 2 strings · removed 1 trailing comma".
// jsonrepair does not report its own actions, and in a tool whose claim is
// exactness a guessed itemization would be worse than none — so anything this
// walk cannot classify, or cannot even align, degrades to null and the badge
// keeps its generic wording. Truthful or silent, never approximate.
//
// Alignment is classification-guided: candidate edits are tried smallest
// first, and a candidate that reads as a KNOWN repair (an inserted quote, a
// deleted trailing comma, None → null) is accepted on a short common run —
// repairs cluster too densely for a long resync anchor ({a: 1} → {"a": 1}
// leaves only the single char `a` between two quote insertions). A candidate
// nothing has a name for must instead prove itself with a long run, and
// counts as "other", which silences the whole phrase.

/** Resync search window: an edit larger than this stops the itemization. */
const WINDOW = 160;
/** Common-run length an UNCLASSIFIED candidate needs to be believed. */
const ANCHOR = 12;

interface Counts {
  quotePairs: number; // inserted bare-name quotes, counted per " then halved
  requoted: number; // ' → " replacements, counted per quote then halved
  trailingCommas: number; // deleted "," whose next real char closes a scope
  insertedCommas: number; // missing separators jsonrepair added
  literals: number; // None/True/False/NaN/Infinity/undefined rewrites
  comments: number; // // and /* */ stripped
  fences: number; // ``` code fences stripped
  other: number;
}

const LITERALS: Record<string, string> = {
  None: 'null',
  True: 'true',
  False: 'false',
  undefined: 'null',
  NaN: 'null',
  Infinity: 'null',
  '-Infinity': 'null',
};

function nextRealChar(text: string, from: number): string {
  for (let k = from; k < text.length; k++) {
    const c = text[k];
    if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') return c;
  }
  return '';
}

function categorize(del: string, ins: string, original: string, endI: number): keyof Counts | null {
  const delTrim = del.trim();
  const insTrim = ins.trim();
  if (delTrim === "'" && insTrim === '"') return 'requoted';
  if (delTrim === '' && insTrim === '"') return 'quotePairs';
  if (insTrim === '' && delTrim === ',') {
    const next = nextRealChar(original, endI);
    return next === '}' || next === ']' ? 'trailingCommas' : null;
  }
  if (delTrim === '' && insTrim === ',') return 'insertedCommas';
  if (insTrim === '' && (delTrim.startsWith('//') || delTrim.startsWith('/*'))) return 'comments';
  if (insTrim === '' && delTrim.startsWith('```')) return 'fences';
  if (LITERALS[delTrim] === insTrim) return 'literals';
  return null;
}

function commonRun(original: string, i: number, repaired: string, j: number): number {
  let n = 0;
  while (n < ANCHOR && i + n < original.length && j + n < repaired.length && original[i + n] === repaired[j + n]) n++;
  return n;
}

function phrase(counts: Counts): string | null {
  const n = (count: number, singular: string, plural = `${singular}s`): string =>
    `${count} ${count === 1 ? singular : plural}`;
  const parts: string[] = [];
  const pairs = Math.floor(counts.quotePairs / 2);
  const strings = Math.floor(counts.requoted / 2);
  if (pairs > 0) parts.push(`added ${n(pairs, 'quote pair')}`);
  if (strings > 0) parts.push(`re-quoted ${n(strings, 'string')}`);
  if (counts.trailingCommas > 0) parts.push(`removed ${n(counts.trailingCommas, 'trailing comma')}`);
  if (counts.insertedCommas > 0) parts.push(`added ${n(counts.insertedCommas, 'missing comma')}`);
  if (counts.literals > 0) parts.push(`rewrote ${n(counts.literals, 'non-JSON literal')}`);
  if (counts.comments > 0) parts.push(`stripped ${n(counts.comments, 'comment')}`);
  if (counts.fences > 0) parts.push('stripped code fences');
  // Half-pairs mean the walk misread quoting; unclassified hunks mean it saw
  // something it has no name for. Either way the phrase would be a guess.
  if (counts.other > 0 || counts.quotePairs % 2 !== 0 || counts.requoted % 2 !== 0) return null;
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function summarizeRepair(original: string, repaired: string): string | null {
  if (original === repaired) return null;
  // The walk is linear but resync is quadratic in WINDOW; cap the input so a
  // pathological paste cannot stall the worker for a tooltip.
  if (original.length + repaired.length > 4_000_000) return null;
  const counts: Counts = {
    quotePairs: 0,
    requoted: 0,
    trailingCommas: 0,
    insertedCommas: 0,
    literals: 0,
    comments: 0,
    fences: 0,
    other: 0,
  };
  let i = 0;
  let j = 0;
  outer: while (i < original.length || j < repaired.length) {
    if (i < original.length && j < repaired.length && original[i] === repaired[j]) {
      i++;
      j++;
      continue;
    }
    // Mismatch: try candidate edits smallest-total first. A candidate that
    // classifies is believed on any nonzero common run (or exact end); one
    // that doesn't must earn belief with a long run, and counts as other.
    for (let total = 1; total <= WINDOW; total++) {
      for (let di = 0; di <= total; di++) {
        const dj = total - di;
        const endI = i + di;
        const endJ = j + dj;
        if (endI > original.length || endJ > repaired.length) continue;
        const bothEnded = endI === original.length && endJ === repaired.length;
        const run = commonRun(original, endI, repaired, endJ);
        if (run === 0 && !bothEnded) continue;
        const cat = categorize(original.slice(i, endI), repaired.slice(j, endJ), original, endI);
        if (cat !== null) {
          counts[cat]++;
          i = endI;
          j = endJ;
          continue outer;
        }
        if (run >= ANCHOR || bothEnded) {
          counts.other++;
          i = endI;
          j = endJ;
          continue outer;
        }
      }
    }
    return null; // nothing in the window realigned — no honest itemization
  }
  return phrase(counts);
}
