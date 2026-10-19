// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Marks the search text where it appears in a row, so a match is SEEN in the
// tree and the hit list rather than inferred from a path. The query grammar is
// the worker's (parseRegexQuery): `/re/` or `/re/i` is a regex, anything else
// a case-insensitive literal. Built from text nodes and <mark> elements only —
// document text never passes through innerHTML.

export type Matcher = (text: string) => [number, number][];

export function makeMatcher(query: string, literal = false): Matcher | null {
  const q = query.trim();
  if (!q) return null;
  if (!literal && q.length >= 2 && q[0] === '/') {
    const last = q.lastIndexOf('/');
    if (last > 0) {
      const pat = q.slice(1, last);
      const flags = q.slice(last + 1);
      if (pat.length > 0 && /^i?$/.test(flags)) {
        let re: RegExp;
        try {
          re = new RegExp(pat, `${flags}g`);
        } catch {
          return null;
        }
        return (text) => {
          const out: [number, number][] = [];
          re.lastIndex = 0;
          for (let m = re.exec(text); m && out.length < 50; m = re.exec(text)) {
            // An empty match (`/x*/`) would mark nothing and loop forever.
            if (m[0].length === 0) {
              re.lastIndex++;
              continue;
            }
            out.push([m.index, m.index + m[0].length]);
          }
          return out;
        };
      }
    }
  }
  const needle = q.toLowerCase();
  return (text) => {
    const out: [number, number][] = [];
    const hay = text.toLowerCase();
    for (let at = hay.indexOf(needle); at !== -1 && out.length < 50; at = hay.indexOf(needle, at + needle.length)) {
      out.push([at, at + needle.length]);
    }
    return out;
  };
}

/** Append `text` to `el`, wrapping each match in <mark class="hl">. */
export function appendMarked(el: HTMLElement, text: string, matcher: Matcher | null): void {
  const ranges = matcher ? matcher(text) : [];
  if (ranges.length === 0) {
    el.append(text);
    return;
  }
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) el.append(text.slice(at, start));
    const mark = document.createElement('mark');
    mark.className = 'hl';
    mark.textContent = text.slice(start, end);
    el.appendChild(mark);
    at = end;
  }
  if (at < text.length) el.append(text.slice(at));
}
