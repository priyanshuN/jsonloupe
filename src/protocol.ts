// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// Contract between the UI thread and the parser worker.
// The UI never holds the parsed document — it only asks for row slices,
// so the worker internals can be swapped (WASM/native) without UI changes.

import type {
  AlignmentPlan,
  SemanticCompareResult,
  SemanticSummary,
} from './semantic';

// 'chunk' is a synthetic range row ([0 … 9999]) interposed when a container has
// more children than CHUNK — so expanding a 5M-element array materializes ~500
// chunk records, not five million node records. Chunks are invisible to paths.
export type NodeType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'chunk';

export interface Row {
  id: number;
  index: number;
  depth: number;
  key: string | number | null;
  type: NodeType;
  preview: string;
  hasChildren: boolean;
  childCount: number;
  expanded: boolean;
  /** Passive annotation, e.g. an epoch timestamp rendered as a date. */
  hint?: string;
  /** Approx serialized byte size of a container's subtree (find the fat node). */
  bytes?: number;
  /** String value that looks like embedded JSON — offer un-stringify. */
  maybeJson?: boolean;
  /** Node whose string value has been unpacked into a subtree. */
  unpacked?: boolean;
}

export interface DiffEntry {
  pathText: string;
  path: (string | number)[];
  left?: string;
  right?: string;
}

export interface DiffResult {
  ok: true;
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  truncated: boolean;
}

// Semantic compare uses one shared virtual row model for both sides. This keeps
// scrolling and expansion structurally aligned without sending either parsed
// document to the UI thread.
export type CompareStatus =
  | 'equal'
  | 'changed'
  | 'added'
  | 'removed'
  | 'moved'
  | 'type'
  | 'ambiguous';

export type CompareFilter =
  | 'all'
  | 'changed'
  | 'added-removed'
  | 'moved'
  | 'ambiguous';

export interface CompareRow {
  id: number;
  index: number;
  depth: number;
  pathText: string;
  status: CompareStatus;
  leftKey?: string | number | null;
  rightKey?: string | number | null;
  leftPreview?: string;
  rightPreview?: string;
  leftIndex?: number;
  rightIndex?: number;
  hasChildren: boolean;
  expanded: boolean;
  matchLabel?: string;
  warning?: string;
}

export interface CompareMeta {
  totalRows: number;
  nodeCount: number;
  summary: SemanticSummary;
  plans: AlignmentPlan[];
  truncated: boolean;
  truncation: SemanticCompareResult['truncation'];
}

export interface CompareOk extends CompareMeta {
  ok: true;
}

export interface CompareError {
  ok: false;
  error: string;
}

export interface ParseOk {
  ok: true;
  totalRows: number;
  parseMs: number;
  jsonl: boolean;
  /** Input was malformed and auto-repaired (trailing commas, single quotes,
   *  Python None/True, truncation) before parsing. The stored raw text stays
   *  the user's original bytes; only the parsed value is the repaired form. */
  repaired: boolean;
  /** What the repair provably did ("added 1 quote pair · removed 1 trailing
   *  comma"), classified from the byte diff — or null when any edit resisted
   *  classification. Truthful or absent, never approximate. */
  repairSummary: string | null;
  /** The document holds at least one number a plain `JSON.parse` would round.
   *  Free to compute — the parser already inspects every numeric literal — and
   *  the run panel needs it, because its scripts see the rounded values. */
  hasUnsafeNumbers: boolean;
}

export interface ParseErr {
  ok: false;
  error: string;
  line: number | null;
  column: number | null;
  context: string | null;
}

export interface SearchHit {
  pathText: string;
  preview: string;
  where: 'key' | 'value';
}
