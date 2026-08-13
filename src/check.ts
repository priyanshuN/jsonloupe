// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// A Check is a deterministic query plus the result count it expects. The query
// engine finds the evidence; this module only decides pass/fail, so browser,
// Playbook and future CLI consumers can share the same small contract.

export type CheckExpectation =
  | { type: 'no-matches' }
  | { type: 'at-least-one' }
  | { type: 'exact-count'; count: number };

export interface CheckEvaluation {
  pass: boolean;
  observed: number;
  summary: string;
}

export function validExpectation(value: unknown): value is CheckExpectation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expectation = value as Record<string, unknown>;
  if (expectation.type === 'no-matches' || expectation.type === 'at-least-one') {
    return Object.keys(expectation).length === 1;
  }
  return expectation.type === 'exact-count'
    && Object.keys(expectation).length === 2
    && Number.isSafeInteger(expectation.count)
    && Number(expectation.count) >= 0;
}

export function expectationText(expectation: CheckExpectation): string {
  if (expectation.type === 'no-matches') return 'no matches';
  if (expectation.type === 'at-least-one') return 'at least one match';
  return `exactly ${expectation.count.toLocaleString('en-IN')} match${expectation.count === 1 ? '' : 'es'}`;
}

export function evaluateCheck(expectation: CheckExpectation, observed: number): CheckEvaluation {
  if (!Number.isSafeInteger(observed) || observed < 0) {
    throw new Error('a check result count must be a non-negative safe integer');
  }
  const pass = expectation.type === 'no-matches'
    ? observed === 0
    : expectation.type === 'at-least-one'
      ? observed > 0
      : observed === expectation.count;
  return {
    pass,
    observed,
    summary: `${pass ? 'Pass' : 'Fail'} — ${observed.toLocaleString('en-IN')} match${observed === 1 ? '' : 'es'}; expected ${expectationText(expectation)}`,
  };
}
