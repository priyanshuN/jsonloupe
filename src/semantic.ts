import { isLosslessNumber } from 'lossless-json';

/**
 * A schema-free comparison mode for a JSON array.
 *
 * `auto` is intentionally conservative. Object collections are identity-aligned
 * only when a stable scalar key (or two-key composite) scores highly. Primitive,
 * mixed, and tuple arrays stay positional because JSON alone cannot tell whether
 * their order is business-significant.
 */
export type ArrayMode = 'auto' | 'identity' | 'unordered' | 'sequence' | 'position';

export type SemanticStatus =
  | 'equal'
  | 'changed'
  | 'added'
  | 'removed'
  | 'moved'
  | 'ambiguous'
  | 'typeChanged'
  | 'truncated';

export interface ArrayRule {
  mode: ArrayMode;
  keys?: string | readonly string[];
}

export interface PathArrayRule extends ArrayRule {
  path: string;
}

export type ArrayRuleMap = Readonly<Record<string, ArrayMode | ArrayRule>>;

export interface SemanticCompareOptions {
  mode?: ArrayMode;
  rules?: ArrayRuleMap | readonly PathArrayRule[];
  /**
   * Maximum number of materialized comparison nodes. The result explicitly
   * reports every cut branch in `truncation`; input data is never mutated.
   */
  nodeCap?: number;
  /**
   * Identity collections are naturally sorted in aligned mode. Original mode
   * keeps the left-side encounter order (right-only rows follow).
   */
  displayMode?: 'aligned' | 'original';
}

export interface MetricBreakdown {
  left: number;
  right: number;
  combined: number;
}

export interface IdentityCandidate {
  keys: string[];
  confidence: number;
  coverage: MetricBreakdown;
  uniqueness: MetricBreakdown;
  overlap: number;
  typeConsistency: number;
  matchedDistinct: number;
  leftDistinct: number;
  rightDistinct: number;
  reliable: boolean;
}

export type InferredArrayKind =
  | 'entity'
  | 'primitive-unknown'
  | 'tuple'
  | 'unordered'
  | 'sequence'
  | 'position'
  | 'mixed-unknown'
  | 'empty-unknown';

export interface AlignmentPlan {
  /** Normalized path: every concrete array index is represented as `[*]`. */
  path: string;
  /** Concrete source location when one exists; useful when several instances share a normalized path. */
  instancePath: string;
  requestedMode: ArrayMode;
  mode: Exclude<ArrayMode, 'auto'>;
  inferredKind: InferredArrayKind;
  keys: string[];
  confidence: number;
  coverage: number;
  uniqueness: number;
  overlap: number;
  typeConsistency: number;
  warnings: string[];
  candidates: IdentityCandidate[];
  counts: {
    left: number;
    right: number;
    matched: number;
    added: number;
    removed: number;
    moved: number;
    ambiguous: number;
  };
}

export interface SemanticSide {
  key: string | number | null;
  index: number | null;
  /** Concrete source path on this side. */
  path: string;
  type: string;
  /** Exact, display-safe preview. Lossless numbers are emitted as digit strings, never wrapper JSON. */
  preview: string;
}

export interface SemanticNode {
  id: number;
  /** Normalized structural path (`[*]` for concrete array positions). */
  path: string;
  /** A display-oriented instance path; identity rows may include their match label. */
  instancePath: string;
  matchPath: string;
  matchLabel: string;
  status: SemanticStatus;
  moved: boolean;
  left: SemanticSide | null;
  right: SemanticSide | null;
  leftKey: string | number | null;
  rightKey: string | number | null;
  leftIndex: number | null;
  rightIndex: number | null;
  leftPreview: string;
  rightPreview: string;
  children: SemanticNode[];
  hasChildren: boolean;
  childCount: number;
  arrayMode?: Exclude<ArrayMode, 'auto'>;
  truncated?: boolean;
}

export interface SemanticSummary {
  changed: number;
  added: number;
  removed: number;
  moved: number;
  ambiguous: number;
  typeChanged: number;
  equal: number;
}

export interface SemanticCompareResult {
  root: SemanticNode;
  summary: SemanticSummary;
  plans: AlignmentPlan[];
  nodeCount: number;
  truncated: boolean;
  truncation: {
    cap: number;
    omittedBranchesAtLeast: number;
    paths: string[];
  };
}

export interface FlattenOptions {
  /**
   * When omitted, all rows are flattened. When supplied, only descendants of
   * expanded node ids are visited (the root itself is always emitted).
   */
  expanded?: ReadonlySet<number>;
  statuses?: ReadonlySet<SemanticStatus>;
  /** Keep ancestor rows needed to reach a matching descendant. Defaults to true. */
  includeAncestors?: boolean;
}

type JsonObject = Record<string, unknown>;

interface ResolvedRule {
  mode: ArrayMode;
  keys: string[];
}

interface BuildLocation {
  normalizedPath: string;
  displayPath: string;
  leftPath: string;
  rightPath: string;
  leftKey: string | number | null;
  rightKey: string | number | null;
  leftIndex: number | null;
  rightIndex: number | null;
  matchLabel: string;
}

interface BuildFlags {
  countSummary?: boolean;
  forcedStatus?: SemanticStatus;
}

interface Context {
  nextId: number;
  cap: number;
  displayMode: 'aligned' | 'original';
  defaultMode: ArrayMode;
  rules: Map<string, ResolvedRule>;
  summary: SemanticSummary;
  plans: AlignmentPlan[];
  truncated: boolean;
  omittedBranchesAtLeast: number;
  truncationPaths: string[];
  root: SemanticNode | null;
}

interface CandidateMeasurement {
  candidate: IdentityCandidate;
  nameHint: number;
}

interface IndexedValue {
  value: unknown;
  index: number;
  path: string;
}

interface IdentityGroup {
  token: string;
  label: string;
  left: IndexedValue[];
  right: IndexedValue[];
  missing: boolean;
}

interface AlignedRow {
  token: string;
  label: string;
  left?: IndexedValue;
  right?: IndexedValue;
  status?: SemanticStatus;
  moved?: boolean;
}

const DEFAULT_NODE_CAP = 50_000;
const MAX_CANDIDATE_FIELDS = 24;
const MAX_PLAN_CANDIDATES = 12;
const RELIABLE_CONFIDENCE = 0.82;
const RELIABLE_COVERAGE = 0.75;
const RELIABLE_UNIQUENESS = 0.9;
const RELIABLE_OVERLAP = 0.6;
const RELIABLE_TYPE_CONSISTENCY = 0.9;
const naturalCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

const EMPTY_SUMMARY = (): SemanticSummary => ({
  changed: 0,
  added: 0,
  removed: 0,
  moved: 0,
  ambiguous: 0,
  typeChanged: 0,
  equal: 0,
});

export function compareSemantic(
  left: unknown,
  right: unknown,
  options: SemanticCompareOptions = {},
): SemanticCompareResult {
  const cap = Number.isFinite(options.nodeCap)
    ? Math.max(1, Math.floor(options.nodeCap as number))
    : DEFAULT_NODE_CAP;
  const ctx: Context = {
    nextId: 1,
    cap,
    displayMode: options.displayMode ?? 'aligned',
    defaultMode: options.mode ?? 'auto',
    rules: normalizeRules(options.rules),
    summary: EMPTY_SUMMARY(),
    plans: [],
    truncated: false,
    omittedBranchesAtLeast: 0,
    truncationPaths: [],
    root: null,
  };

  const rootLocation: BuildLocation = {
    normalizedPath: '$',
    displayPath: '$',
    leftPath: '$',
    rightPath: '$',
    leftKey: null,
    rightKey: null,
    leftIndex: null,
    rightIndex: null,
    matchLabel: '$',
  };
  const root = buildNode(ctx, left, right, rootLocation, { countSummary: true });
  // cap is clamped to at least one, so the root allocation always succeeds.
  if (!root) throw new Error('semantic comparison could not materialize its root node');
  ctx.root = root;
  if (ctx.truncated) {
    root.truncated = true;
    root.status = 'truncated';
  }

  return {
    root,
    summary: ctx.summary,
    plans: ctx.plans,
    nodeCount: ctx.nextId - 1,
    truncated: ctx.truncated,
    truncation: {
      cap,
      omittedBranchesAtLeast: ctx.omittedBranchesAtLeast,
      paths: ctx.truncationPaths,
    },
  };
}

/**
 * Flatten a comparison tree for a virtualized UI. Status filtering retains the
 * ancestor chain by default so every result remains navigable.
 */
export function flattenVisibleRows(
  root: SemanticNode,
  options: FlattenOptions = {},
): SemanticNode[] {
  const includeAncestors = options.includeAncestors ?? true;
  const statuses = options.statuses;
  const expanded = options.expanded;
  const matches = new Map<number, boolean>();

  const subtreeMatches = (node: SemanticNode): boolean => {
    const selfMatches = !statuses || statuses.has(node.status);
    let descendantMatches = false;
    for (const child of node.children) {
      if (subtreeMatches(child)) descendantMatches = true;
    }
    const result = selfMatches || (includeAncestors && descendantMatches);
    matches.set(node.id, result);
    return result;
  };
  subtreeMatches(root);

  const rows: SemanticNode[] = [];
  const visit = (node: SemanticNode, isRoot: boolean): void => {
    if (!matches.get(node.id) && !isRoot) return;
    const selfMatches = !statuses || statuses.has(node.status);
    if (selfMatches || includeAncestors || isRoot) rows.push(node);
    if (expanded && !expanded.has(node.id)) return;
    for (const child of node.children) visit(child, false);
  };
  visit(root, true);
  return rows;
}

/** Exact scalar/structural equality with object key order ignored. */
export function semanticValueEqual(left: unknown, right: unknown): boolean {
  if (scalarEqual(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      if (!semanticValueEqual(left[i], right[i])) return false;
    }
    return true;
  }
  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) return false;
    const leftKeys = Object.keys(left).sort(naturalCompare);
    const rightKeys = Object.keys(right).sort(naturalCompare);
    if (leftKeys.length !== rightKeys.length) return false;
    for (let i = 0; i < leftKeys.length; i++) {
      if (leftKeys[i] !== rightKeys[i]) return false;
      if (!semanticValueEqual(left[leftKeys[i]], right[rightKeys[i]])) return false;
    }
    return true;
  }
  return false;
}

function normalizeRules(
  rules: SemanticCompareOptions['rules'],
): Map<string, ResolvedRule> {
  const result = new Map<string, ResolvedRule>();
  if (!rules) return result;
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      result.set(rule.path, {
        mode: rule.mode,
        keys: normalizeKeys(rule.keys),
      });
    }
    return result;
  }
  for (const [path, raw] of Object.entries(rules)) {
    result.set(
      path,
      typeof raw === 'string'
        ? { mode: raw, keys: [] }
        : { mode: raw.mode, keys: normalizeKeys(raw.keys) },
    );
  }
  return result;
}

function normalizeKeys(keys: string | readonly string[] | undefined): string[] {
  const values = typeof keys === 'string' ? keys.split(',') : keys ?? [];
  return [...new Set(values.map((key) => key.trim()).filter(Boolean))];
}

function buildNode(
  ctx: Context,
  left: unknown,
  right: unknown,
  location: BuildLocation,
  flags: BuildFlags = {},
): SemanticNode | null {
  const node = allocateNode(ctx, left, right, location, flags.forcedStatus ?? 'equal');
  if (!node) return null;

  if (flags.forcedStatus === 'added' || flags.forcedStatus === 'removed') {
    if (flags.countSummary !== false) ctx.summary[flags.forcedStatus]++;
    buildOneSidedChildren(ctx, node, left, right, location, flags.forcedStatus);
    finishNode(node);
    return node;
  }
  if (flags.forcedStatus === 'ambiguous') {
    if (flags.countSummary !== false) ctx.summary.ambiguous++;
    buildComparableChildren(ctx, node, left, right, location, false);
    node.status = 'ambiguous';
    finishNode(node);
    return node;
  }

  const leftType = valueType(left);
  const rightType = valueType(right);
  if (leftType !== rightType) {
    node.status = 'typeChanged';
    if (flags.countSummary !== false) ctx.summary.typeChanged++;
    finishNode(node);
    return node;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    buildArrayChildren(ctx, node, left, right, location);
    finishNode(node);
    return node;
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    buildObjectChildren(ctx, node, left, right, location);
    finishNode(node);
    return node;
  }

  if (scalarEqual(left, right)) {
    node.status = 'equal';
    if (flags.countSummary !== false) ctx.summary.equal++;
  } else {
    node.status = 'changed';
    if (flags.countSummary !== false) ctx.summary.changed++;
  }
  finishNode(node);
  return node;
}

function buildComparableChildren(
  ctx: Context,
  node: SemanticNode,
  left: unknown,
  right: unknown,
  location: BuildLocation,
  countSummary: boolean,
): void {
  if (Array.isArray(left) && Array.isArray(right)) {
    buildPositionalRows(ctx, node, left, right, location, 'position', false, countSummary);
  } else if (isJsonObject(left) && isJsonObject(right)) {
    buildObjectChildren(ctx, node, left, right, location, countSummary);
  }
}

function buildOneSidedChildren(
  ctx: Context,
  node: SemanticNode,
  left: unknown,
  right: unknown,
  location: BuildLocation,
  forcedStatus: 'added' | 'removed',
): void {
  const value = forcedStatus === 'removed' ? left : right;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const childLocation = arrayChildLocation(
        location,
        forcedStatus === 'removed' ? i : null,
        forcedStatus === 'added' ? i : null,
        String(i),
      );
      const child = buildNode(
        ctx,
        forcedStatus === 'removed' ? value[i] : undefined,
        forcedStatus === 'added' ? value[i] : undefined,
        childLocation,
        { countSummary: false, forcedStatus },
      );
      if (!child) {
        markTruncated(ctx, node, location.normalizedPath, value.length - i);
        break;
      }
      node.children.push(child);
    }
  } else if (isJsonObject(value)) {
    const keys = Object.keys(value).sort(naturalCompare);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const childLocation = objectChildLocation(
        location,
        forcedStatus === 'removed' ? key : null,
        forcedStatus === 'added' ? key : null,
        key,
      );
      const child = buildNode(
        ctx,
        forcedStatus === 'removed' ? value[key] : undefined,
        forcedStatus === 'added' ? value[key] : undefined,
        childLocation,
        { countSummary: false, forcedStatus },
      );
      if (!child) {
        markTruncated(ctx, node, location.normalizedPath, keys.length - i);
        break;
      }
      node.children.push(child);
    }
  }
}

function buildObjectChildren(
  ctx: Context,
  node: SemanticNode,
  left: JsonObject,
  right: JsonObject,
  location: BuildLocation,
  countSummary = true,
): void {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(naturalCompare);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const hasLeft = Object.prototype.hasOwnProperty.call(left, key);
    const hasRight = Object.prototype.hasOwnProperty.call(right, key);
    const childLocation = objectChildLocation(
      location,
      hasLeft ? key : null,
      hasRight ? key : null,
      key,
    );
    const child = buildNode(
      ctx,
      hasLeft ? left[key] : undefined,
      hasRight ? right[key] : undefined,
      childLocation,
      hasLeft && hasRight
        ? { countSummary }
        : {
            countSummary,
            forcedStatus: hasLeft ? 'removed' : 'added',
          },
    );
    if (!child) {
      markTruncated(ctx, node, location.normalizedPath, keys.length - i);
      break;
    }
    node.children.push(child);
  }
  node.status = aggregateStatus(node.children);
}

function buildArrayChildren(
  ctx: Context,
  node: SemanticNode,
  left: unknown[],
  right: unknown[],
  location: BuildLocation,
): void {
  const rule = resolveRule(ctx, location);
  const requestedMode = rule?.mode ?? ctx.defaultMode;
  const explicitKeys = rule?.keys ?? [];
  const objectArrays = allObjects(left) && allObjects(right) && left.length > 0 && right.length > 0;
  const primitiveArrays = allScalars(left) && allScalars(right);
  const tupleArrays = allArrays(left) && allArrays(right);
  const candidates = objectArrays ? discoverIdentityCandidates(left, right) : [];
  const bestCandidate = candidates[0];
  const warnings: string[] = [];
  let mode: Exclude<ArrayMode, 'auto'>;
  let inferredKind: InferredArrayKind;
  let keys = explicitKeys;
  let confidence = 1;

  if (requestedMode === 'auto') {
    if (objectArrays && bestCandidate?.reliable) {
      mode = 'identity';
      inferredKind = 'entity';
      keys = bestCandidate.keys;
      confidence = bestCandidate.confidence;
    } else if (objectArrays) {
      mode = 'position';
      inferredKind = left.length === 0 && right.length === 0 ? 'empty-unknown' : 'mixed-unknown';
      confidence = bestCandidate?.confidence ?? 0;
      warnings.push(
        'No high-confidence identity was found; object elements were compared positionally.',
      );
    } else if (primitiveArrays) {
      mode = 'position';
      inferredKind = left.length === 0 && right.length === 0 ? 'empty-unknown' : 'primitive-unknown';
      confidence = 0;
      warnings.push(
        'Primitive-array order is unknowable from JSON alone; compared positionally. Choose unordered explicitly for multiset semantics.',
      );
    } else if (tupleArrays) {
      mode = 'position';
      inferredKind = 'tuple';
      confidence = 1;
    } else {
      mode = 'position';
      inferredKind = left.length === 0 && right.length === 0 ? 'empty-unknown' : 'mixed-unknown';
      confidence = 0;
      warnings.push(
        'Heterogeneous-array semantics are unknowable from JSON alone; compared positionally.',
      );
    }
  } else {
    mode = requestedMode;
    inferredKind =
      mode === 'identity'
        ? 'entity'
        : mode === 'unordered'
          ? 'unordered'
          : mode === 'sequence'
            ? 'sequence'
            : 'position';
    if (mode === 'identity' && keys.length === 0) {
      if (bestCandidate) {
        keys = bestCandidate.keys;
        confidence = bestCandidate.confidence;
        if (!bestCandidate.reliable) {
          warnings.push(
            'Identity mode is using the best available low-confidence key; missing and duplicate identities remain ambiguous.',
          );
        }
      } else {
        warnings.push(
          'Identity mode could not find any direct scalar candidate key; positional comparison was used.',
        );
        mode = 'position';
        inferredKind = 'mixed-unknown';
        confidence = 0;
      }
    } else if (mode === 'identity' && !objectArrays) {
      confidence = 0;
      warnings.push(
        'Identity mode is configured for an array that is not object-only; elements without the configured scalar keys remain ambiguous.',
      );
    } else if (mode === 'sequence' && keys.length === 0 && bestCandidate?.reliable) {
      // Ordered object sequences still need an identity to align the same item
      // across positions. Order remains meaningful because moved rows are
      // reported separately.
      keys = bestCandidate.keys;
      confidence = bestCandidate.confidence;
    }
  }

  const metrics =
    keys.length > 0
      ? candidates.find((candidate) => sameKeys(candidate.keys, keys)) ??
        measureCandidate(left, right, keys)?.candidate
      : requestedMode === 'auto' && objectArrays
        ? bestCandidate
        : undefined;
  const plan: AlignmentPlan = {
    path: location.normalizedPath,
    instancePath: preferredInstancePath(location),
    requestedMode,
    mode,
    inferredKind,
    keys: [...keys],
    confidence: roundMetric(metrics?.confidence ?? confidence),
    coverage: roundMetric(metrics?.coverage.combined ?? (mode === 'identity' ? 0 : confidence)),
    uniqueness: roundMetric(metrics?.uniqueness.combined ?? (mode === 'identity' ? 0 : confidence)),
    overlap: roundMetric(metrics?.overlap ?? (mode === 'identity' ? 0 : confidence)),
    typeConsistency: roundMetric(metrics?.typeConsistency ?? (mode === 'identity' ? 0 : confidence)),
    warnings,
    candidates: candidates.slice(0, MAX_PLAN_CANDIDATES),
    counts: {
      left: left.length,
      right: right.length,
      matched: 0,
      added: 0,
      removed: 0,
      moved: 0,
      ambiguous: 0,
    },
  };
  ctx.plans.push(plan);
  node.arrayMode = mode;

  if (mode === 'identity') {
    buildIdentityRows(ctx, node, left, right, location, keys, plan);
  } else if (mode === 'unordered') {
    buildUnorderedRows(ctx, node, left, right, location, plan);
  } else if (mode === 'sequence' && (keys.length > 0 || primitiveArrays)) {
    if (keys.length > 0) buildIdentityRows(ctx, node, left, right, location, keys, plan);
    else buildUnorderedRows(ctx, node, left, right, location, plan);
  } else {
    buildPositionalRows(
      ctx,
      node,
      left,
      right,
      location,
      mode,
      mode === 'sequence',
      true,
      plan,
    );
  }
  node.status = aggregateStatus(node.children);
}

function buildIdentityRows(
  ctx: Context,
  node: SemanticNode,
  left: unknown[],
  right: unknown[],
  location: BuildLocation,
  keys: string[],
  plan: AlignmentPlan,
): void {
  const groups = groupIdentityValues(left, right, keys, location);
  const rows: AlignedRow[] = [];
  for (const group of groups) {
    if (group.missing || group.left.length > 1 || group.right.length > 1) {
      // Duplicate or missing identities are not enough to choose a changed
      // partner. Canonically identical objects are nevertheless a certain
      // match (object key order ignored); only the unresolved remainder stays
      // ambiguous. This prevents a duplicate group from hiding an exact row.
      const exact = pairCanonicalExact(group.left, group.right);
      for (const [leftValue, rightValue] of exact.pairs) {
        const moved = leftValue.index !== rightValue.index;
        rows.push({
          token: group.token,
          label: group.label,
          left: leftValue,
          right: rightValue,
          moved,
        });
        plan.counts.matched++;
        if (moved) plan.counts.moved++;
      }
      const pairings = pairSameIndexFirst(exact.leftRemaining, exact.rightRemaining);
      for (const [leftValue, rightValue] of pairings) {
        rows.push({
          token: group.token,
          label: group.label,
          left: leftValue,
          right: rightValue,
          status: 'ambiguous',
          moved:
            !!leftValue &&
            !!rightValue &&
            leftValue.index !== rightValue.index,
        });
        plan.counts.ambiguous++;
      }
      continue;
    }
    const leftValue = group.left[0];
    const rightValue = group.right[0];
    if (leftValue && rightValue) {
      const moved = leftValue.index !== rightValue.index;
      rows.push({
        token: group.token,
        label: group.label,
        left: leftValue,
        right: rightValue,
        moved,
      });
      plan.counts.matched++;
      if (moved) plan.counts.moved++;
    } else if (leftValue) {
      rows.push({
        token: group.token,
        label: group.label,
        left: leftValue,
        status: 'removed',
      });
      plan.counts.removed++;
    } else if (rightValue) {
      rows.push({
        token: group.token,
        label: group.label,
        right: rightValue,
        status: 'added',
      });
      plan.counts.added++;
    }
  }

  sortAlignedRows(rows, ctx.displayMode);
  materializeAlignedRows(ctx, node, rows, location, plan);
}

function buildUnorderedRows(
  ctx: Context,
  node: SemanticNode,
  left: unknown[],
  right: unknown[],
  location: BuildLocation,
  plan: AlignmentPlan,
): void {
  const leftGroups = groupByCanonical(left, location.leftPath);
  const rightGroups = groupByCanonical(right, location.rightPath);
  const tokens = [...new Set([...leftGroups.keys(), ...rightGroups.keys()])].sort((a, b) =>
    naturalCompare(groupLabel(leftGroups.get(a), rightGroups.get(a)), groupLabel(leftGroups.get(b), rightGroups.get(b))),
  );
  const rows: AlignedRow[] = [];
  for (const token of tokens) {
    const leftValues = leftGroups.get(token) ?? [];
    const rightValues = rightGroups.get(token) ?? [];
    const pairs = pairSameIndexFirst(leftValues, rightValues);
    for (let occurrence = 0; occurrence < pairs.length; occurrence++) {
      const [leftValue, rightValue] = pairs[occurrence];
      const label = `${previewValue(leftValue?.value ?? rightValue?.value)}${
        pairs.length > 1 ? ` #${occurrence + 1}` : ''
      }`;
      if (leftValue && rightValue) {
        const moved = leftValue.index !== rightValue.index;
        rows.push({ token, label, left: leftValue, right: rightValue, moved });
        plan.counts.matched++;
        if (moved) plan.counts.moved++;
      } else if (leftValue) {
        rows.push({ token, label, left: leftValue, status: 'removed' });
        plan.counts.removed++;
      } else if (rightValue) {
        rows.push({ token, label, right: rightValue, status: 'added' });
        plan.counts.added++;
      }
    }
  }
  if (ctx.displayMode === 'original') sortAlignedRows(rows, 'original');
  materializeAlignedRows(ctx, node, rows, location, plan);
}

function materializeAlignedRows(
  ctx: Context,
  node: SemanticNode,
  rows: AlignedRow[],
  location: BuildLocation,
  plan: AlignmentPlan,
): void {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const childLocation = arrayChildLocation(
      location,
      row.left?.index ?? null,
      row.right?.index ?? null,
      row.label,
    );
    const forcedStatus = row.status;
    const child = buildNode(
      ctx,
      row.left?.value,
      row.right?.value,
      childLocation,
      forcedStatus
        ? { countSummary: true, forcedStatus }
        : { countSummary: true },
    );
    if (!child) {
      markTruncated(ctx, node, location.normalizedPath, rows.length - i);
      break;
    }
    if (row.moved) {
      child.moved = true;
      child.leftIndex = row.left?.index ?? null;
      child.rightIndex = row.right?.index ?? null;
      if (child.status === 'equal') child.status = 'moved';
      ctx.summary.moved++;
    }
    node.children.push(child);
  }
  // Counts are computed independently of materialization, so a capped result
  // remains explicit about which alignment rows existed.
  plan.counts.moved = rows.filter((row) => row.moved).length;
}

function buildPositionalRows(
  ctx: Context,
  node: SemanticNode,
  left: unknown[],
  right: unknown[],
  location: BuildLocation,
  mode: 'position' | 'sequence',
  detectMoves: boolean,
  countSummary: boolean,
  plan?: AlignmentPlan,
): void {
  const moveTargets = detectMoves ? positionalMoveTargets(left, right) : new Map<number, number>();
  const length = Math.max(left.length, right.length);
  if (plan) {
    plan.counts.matched = Math.min(left.length, right.length);
    plan.counts.removed = Math.max(0, left.length - right.length);
    plan.counts.added = Math.max(0, right.length - left.length);
    plan.counts.moved = moveTargets.size;
  }
  for (let i = 0; i < length; i++) {
    const hasLeft = i < left.length;
    const hasRight = i < right.length;
    const moveTarget = moveTargets.get(i);
    const childLocation = arrayChildLocation(
      location,
      hasLeft ? i : null,
      hasRight ? i : null,
      moveTarget === undefined ? String(i) : `${i} → ${moveTarget}`,
    );
    const child = buildNode(
      ctx,
      hasLeft ? left[i] : undefined,
      hasRight ? right[i] : undefined,
      childLocation,
      hasLeft && hasRight
        ? { countSummary }
        : {
            countSummary,
            forcedStatus: hasLeft ? 'removed' : 'added',
          },
    );
    if (!child) {
      markTruncated(ctx, node, location.normalizedPath, length - i);
      break;
    }
    if (moveTarget !== undefined) {
      child.moved = true;
      ctx.summary.moved++;
    }
    node.children.push(child);
  }
  node.arrayMode = mode;
}

function positionalMoveTargets(left: unknown[], right: unknown[]): Map<number, number> {
  const targets = new Map<number, number>();
  let leftGroups: Map<string, IndexedValue[]>;
  let rightGroups: Map<string, IndexedValue[]>;
  if (allObjects(left) && allObjects(right) && left.length > 0 && right.length > 0) {
    const candidate = discoverIdentityCandidates(left, right)[0];
    if (candidate?.reliable) {
      leftGroups = groupByIdentityToken(left, candidate.keys, '$');
      rightGroups = groupByIdentityToken(right, candidate.keys, '$');
    } else {
      leftGroups = groupByCanonical(left, '$');
      rightGroups = groupByCanonical(right, '$');
    }
  } else {
    leftGroups = groupByCanonical(left, '$');
    rightGroups = groupByCanonical(right, '$');
  }
  for (const [token, leftValues] of leftGroups) {
    const rightValues = rightGroups.get(token);
    if (!rightValues) continue;
    for (const [leftValue, rightValue] of pairSameIndexFirst(leftValues, rightValues)) {
      if (leftValue && rightValue && leftValue.index !== rightValue.index) {
        targets.set(leftValue.index, rightValue.index);
      }
    }
  }
  return targets;
}

function groupByIdentityToken(
  values: unknown[],
  keys: string[],
  basePath: string,
): Map<string, IndexedValue[]> {
  const groups = new Map<string, IndexedValue[]>();
  values.forEach((value, index) => {
    const identity = identityToken(value, keys);
    if (!identity) return;
    const group = groups.get(identity.token) ?? [];
    group.push({ value, index, path: `${basePath}[${index}]` });
    groups.set(identity.token, group);
  });
  return groups;
}

function allocateNode(
  ctx: Context,
  left: unknown,
  right: unknown,
  location: BuildLocation,
  status: SemanticStatus,
): SemanticNode | null {
  if (ctx.nextId > ctx.cap) return null;
  const id = ctx.nextId++;
  return {
    id,
    path: location.normalizedPath,
    instancePath: location.displayPath,
    matchPath: location.normalizedPath,
    matchLabel: location.matchLabel,
    status,
    moved: false,
    left: sideOf(left, location.leftKey, location.leftIndex, location.leftPath),
    right: sideOf(right, location.rightKey, location.rightIndex, location.rightPath),
    leftKey: location.leftKey,
    rightKey: location.rightKey,
    leftIndex: location.leftIndex,
    rightIndex: location.rightIndex,
    leftPreview: left === undefined ? '' : previewValue(left),
    rightPreview: right === undefined ? '' : previewValue(right),
    children: [],
    hasChildren: false,
    childCount: 0,
  };
}

function sideOf(
  value: unknown,
  key: string | number | null,
  index: number | null,
  path: string,
): SemanticSide | null {
  if (value === undefined) return null;
  return {
    key,
    index,
    path,
    type: valueType(value),
    preview: previewValue(value),
  };
}

function finishNode(node: SemanticNode): void {
  node.childCount = node.children.length;
  node.hasChildren = node.children.length > 0 || !!node.truncated;
  if (node.truncated) node.status = 'truncated';
}

function markTruncated(
  ctx: Context,
  node: SemanticNode,
  path: string,
  omittedBranchesAtLeast: number,
): void {
  ctx.truncated = true;
  ctx.omittedBranchesAtLeast += Math.max(1, omittedBranchesAtLeast);
  if (ctx.truncationPaths.length < 32 && !ctx.truncationPaths.includes(path)) {
    ctx.truncationPaths.push(path);
  }
  node.truncated = true;
  node.status = 'truncated';
  node.hasChildren = true;
}

function aggregateStatus(children: readonly SemanticNode[]): SemanticStatus {
  if (children.some((child) => child.status === 'truncated')) return 'truncated';
  if (children.some((child) => child.status === 'typeChanged')) return 'changed';
  if (children.some((child) => child.status === 'added' || child.status === 'removed' || child.status === 'changed')) {
    return 'changed';
  }
  if (children.some((child) => child.status === 'ambiguous')) return 'ambiguous';
  if (children.some((child) => child.status === 'moved' || child.moved)) return 'moved';
  return 'equal';
}

function objectChildLocation(
  parent: BuildLocation,
  leftKey: string | null,
  rightKey: string | null,
  label: string,
): BuildLocation {
  const key = leftKey ?? rightKey ?? label;
  const seg = formatObjectSegment(key);
  return {
    normalizedPath: `${parent.normalizedPath}${seg}`,
    displayPath: `${parent.displayPath}${seg}`,
    leftPath: leftKey === null ? parent.leftPath : `${parent.leftPath}${formatObjectSegment(leftKey)}`,
    rightPath: rightKey === null ? parent.rightPath : `${parent.rightPath}${formatObjectSegment(rightKey)}`,
    leftKey,
    rightKey,
    leftIndex: null,
    rightIndex: null,
    matchLabel: label,
  };
}

function arrayChildLocation(
  parent: BuildLocation,
  leftIndex: number | null,
  rightIndex: number | null,
  label: string,
): BuildLocation {
  // Escape the escape character first, or a label containing a literal
  // backslash before ']' is indistinguishable from the escaping itself.
  const safeLabel = label.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
  return {
    normalizedPath: `${parent.normalizedPath}[*]`,
    displayPath: `${parent.displayPath}[${safeLabel}]`,
    leftPath: leftIndex === null ? parent.leftPath : `${parent.leftPath}[${leftIndex}]`,
    rightPath: rightIndex === null ? parent.rightPath : `${parent.rightPath}[${rightIndex}]`,
    leftKey: leftIndex,
    rightKey: rightIndex,
    leftIndex,
    rightIndex,
    matchLabel: label,
  };
}

function formatObjectSegment(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `.${key}`
    : `[${JSON.stringify(key)}]`;
}

function preferredInstancePath(location: BuildLocation): string {
  if (location.leftPath !== '$' || location.rightPath === '$') return location.leftPath;
  return location.rightPath;
}

function resolveRule(ctx: Context, location: BuildLocation): ResolvedRule | undefined {
  // A concrete instance is more specific than the normalized wildcard form.
  return (
    ctx.rules.get(location.leftPath) ??
    ctx.rules.get(location.rightPath) ??
    ctx.rules.get(location.normalizedPath)
  );
}

function normalizeReportedPath(path: string): string {
  return path.replace(/\[\d+\]/g, '[*]');
}

function discoverIdentityCandidates(left: unknown[], right: unknown[]): IdentityCandidate[] {
  const fieldStats = new Map<string, number>();
  for (const value of [...left, ...right]) {
    if (!isJsonObject(value)) continue;
    for (const [key, fieldValue] of Object.entries(value)) {
      if (identityScalarToken(fieldValue) !== null) {
        fieldStats.set(key, (fieldStats.get(key) ?? 0) + 1);
      }
    }
  }
  const fields = [...fieldStats.entries()]
    .sort((a, b) => b[1] - a[1] || naturalCompare(a[0], b[0]))
    .slice(0, MAX_CANDIDATE_FIELDS)
    .map(([key]) => key);
  const measured: CandidateMeasurement[] = [];
  for (const field of fields) {
    const measurement = measureCandidate(left, right, [field]);
    if (measurement) measured.push(measurement);
  }
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const measurement = measureCandidate(left, right, [fields[i], fields[j]]);
      if (measurement) measured.push(measurement);
    }
  }
  measured.sort(compareCandidateMeasurements);
  return measured.map(({ candidate }) => candidate);
}

function measureCandidate(
  left: unknown[],
  right: unknown[],
  keys: string[],
): CandidateMeasurement | null {
  if (keys.length === 0) return null;
  const leftTokens = identityTokens(left, keys);
  const rightTokens = identityTokens(right, keys);
  if (leftTokens.present === 0 && rightTokens.present === 0) return null;

  const leftCoverage = ratio(leftTokens.present, left.length);
  const rightCoverage = ratio(rightTokens.present, right.length);
  const coverage = Math.min(leftCoverage, rightCoverage);
  const leftUniqueness = ratio(leftTokens.counts.size, leftTokens.present);
  const rightUniqueness = ratio(rightTokens.counts.size, rightTokens.present);
  const uniqueness = Math.min(leftUniqueness, rightUniqueness);
  let matchedDistinct = 0;
  for (const token of leftTokens.counts.keys()) {
    if (rightTokens.counts.has(token)) matchedDistinct++;
  }
  const overlap = ratio(
    matchedDistinct,
    Math.max(leftTokens.counts.size, rightTokens.counts.size),
  );
  const typeConsistency = candidateTypeConsistency(left, right, keys);
  const confidence =
    coverage * 0.25 +
    uniqueness * 0.25 +
    overlap * 0.4 +
    typeConsistency * 0.1;
  const reliable =
    confidence >= RELIABLE_CONFIDENCE &&
    coverage >= RELIABLE_COVERAGE &&
    uniqueness >= RELIABLE_UNIQUENESS &&
    overlap >= RELIABLE_OVERLAP &&
    typeConsistency >= RELIABLE_TYPE_CONSISTENCY;
  return {
    candidate: {
      keys: [...keys],
      confidence,
      coverage: {
        left: leftCoverage,
        right: rightCoverage,
        combined: coverage,
      },
      uniqueness: {
        left: leftUniqueness,
        right: rightUniqueness,
        combined: uniqueness,
      },
      overlap,
      typeConsistency,
      matchedDistinct,
      leftDistinct: leftTokens.counts.size,
      rightDistinct: rightTokens.counts.size,
      reliable,
    },
    nameHint: keys.reduce((sum, key) => sum + identityNameHint(key), 0),
  };
}

function compareCandidateMeasurements(a: CandidateMeasurement, b: CandidateMeasurement): number {
  const ac = a.candidate;
  const bc = b.candidate;
  return (
    compareMetricDesc(ac.confidence, bc.confidence) ||
    compareMetricDesc(ac.coverage.combined, bc.coverage.combined) ||
    compareMetricDesc(ac.uniqueness.combined, bc.uniqueness.combined) ||
    compareMetricDesc(ac.overlap, bc.overlap) ||
    compareMetricDesc(ac.typeConsistency, bc.typeConsistency) ||
    ac.keys.length - bc.keys.length ||
    b.nameHint - a.nameHint ||
    naturalCompare(ac.keys.join('\u0000'), bc.keys.join('\u0000'))
  );
}

function compareMetricDesc(a: number, b: number): number {
  return Math.abs(a - b) < 1e-9 ? 0 : b - a;
}

function identityNameHint(key: string): number {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  if (/^(id|key|uuid)$/.test(normalized)) return 4;
  if (/(id|key|uuid|code|ref|sku)$/.test(normalized)) return 3;
  if (/(name|number|no)$/.test(normalized)) return 1;
  return 0;
}

function identityTokens(
  values: unknown[],
  keys: string[],
): { present: number; counts: Map<string, number> } {
  let present = 0;
  const counts = new Map<string, number>();
  for (const value of values) {
    const token = identityToken(value, keys);
    if (!token) continue;
    present++;
    counts.set(token.token, (counts.get(token.token) ?? 0) + 1);
  }
  return { present, counts };
}

function candidateTypeConsistency(
  left: unknown[],
  right: unknown[],
  keys: string[],
): number {
  let sum = 0;
  for (const key of keys) {
    const counts = new Map<string, number>();
    let total = 0;
    for (const value of [...left, ...right]) {
      if (!isJsonObject(value) || !Object.prototype.hasOwnProperty.call(value, key)) continue;
      const field = value[key];
      const token = identityScalarToken(field);
      if (token === null) continue;
      const type = scalarTypeTag(field);
      counts.set(type, (counts.get(type) ?? 0) + 1);
      total++;
    }
    let dominant = 0;
    for (const count of counts.values()) dominant = Math.max(dominant, count);
    sum += ratio(dominant, total);
  }
  return ratio(sum, keys.length);
}

function groupIdentityValues(
  left: unknown[],
  right: unknown[],
  keys: string[],
  location: BuildLocation,
): IdentityGroup[] {
  const groups = new Map<string, IdentityGroup>();
  const add = (side: 'left' | 'right', value: unknown, index: number): void => {
    const identity = identityToken(value, keys);
    const missing = identity === null;
    const token = missing ? '\u0000missing' : identity.token;
    let group = groups.get(token);
    if (!group) {
      group = {
        token,
        label: missing ? `<missing ${keys.join(' + ')}>` : identity.label,
        left: [],
        right: [],
        missing,
      };
      groups.set(token, group);
    }
    group[side].push({
      value,
      index,
      path: `${side === 'left' ? location.leftPath : location.rightPath}[${index}]`,
    });
  };
  left.forEach((value, index) => add('left', value, index));
  right.forEach((value, index) => add('right', value, index));
  return [...groups.values()];
}

function identityToken(
  value: unknown,
  keys: string[],
): { token: string; label: string } | null {
  if (!isJsonObject(value)) return null;
  const parts: string[] = [];
  const labels: string[] = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return null;
    const field = value[key];
    const token = identityScalarToken(field);
    if (token === null) return null;
    parts.push(`${key.length}:${key}=${token}`);
    labels.push(`${key}=${previewValue(field)}`);
  }
  return {
    token: parts.join('|'),
    label: labels.join(' + '),
  };
}

function identityScalarToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (isLosslessNumber(value)) return `n:${value.toString().length}:${value.toString()}`;
  switch (typeof value) {
    case 'string':
      return `s:${value.length}:${value}`;
    case 'number':
      return Number.isFinite(value) ? `n:${String(value).length}:${String(value)}` : null;
    case 'boolean':
      return value ? 'b:1' : 'b:0';
    default:
      return null;
  }
}

function scalarTypeTag(value: unknown): string {
  if (isLosslessNumber(value)) return 'number';
  return typeof value;
}

function groupByCanonical(values: unknown[], basePath: string): Map<string, IndexedValue[]> {
  const groups = new Map<string, IndexedValue[]>();
  values.forEach((value, index) => {
    const token = canonicalValue(value);
    const group = groups.get(token) ?? [];
    group.push({ value, index, path: `${basePath}[${index}]` });
    groups.set(token, group);
  });
  return groups;
}

function pairCanonicalExact(
  left: IndexedValue[],
  right: IndexedValue[],
): {
  pairs: [IndexedValue, IndexedValue][];
  leftRemaining: IndexedValue[];
  rightRemaining: IndexedValue[];
} {
  const rightByToken = new Map<string, IndexedValue[]>();
  for (const value of right) {
    const token = canonicalValue(value.value);
    const group = rightByToken.get(token) ?? [];
    group.push(value);
    rightByToken.set(token, group);
  }

  const pairs: [IndexedValue, IndexedValue][] = [];
  const leftRemaining: IndexedValue[] = [];
  const usedRight = new Set<IndexedValue>();
  for (const leftValue of left) {
    const candidates = rightByToken.get(canonicalValue(leftValue.value));
    if (!candidates?.length) {
      leftRemaining.push(leftValue);
      continue;
    }
    const sameIndex = candidates.findIndex((candidate) => candidate.index === leftValue.index);
    const [rightValue] = candidates.splice(sameIndex >= 0 ? sameIndex : 0, 1);
    usedRight.add(rightValue);
    pairs.push([leftValue, rightValue]);
  }
  return {
    pairs,
    leftRemaining,
    rightRemaining: right.filter((value) => !usedRight.has(value)),
  };
}

function pairSameIndexFirst(
  left: IndexedValue[],
  right: IndexedValue[],
): [IndexedValue | undefined, IndexedValue | undefined][] {
  const rightRemaining = new Map(right.map((value) => [value.index, value]));
  const leftRemaining: IndexedValue[] = [];
  const pairs: [IndexedValue | undefined, IndexedValue | undefined][] = [];
  for (const leftValue of left) {
    const sameIndex = rightRemaining.get(leftValue.index);
    if (sameIndex) {
      pairs.push([leftValue, sameIndex]);
      rightRemaining.delete(leftValue.index);
    } else {
      leftRemaining.push(leftValue);
    }
  }
  const remainingRight = [...rightRemaining.values()].sort((a, b) => a.index - b.index);
  const count = Math.max(leftRemaining.length, remainingRight.length);
  for (let i = 0; i < count; i++) {
    pairs.push([leftRemaining[i], remainingRight[i]]);
  }
  return pairs;
}

function sortAlignedRows(rows: AlignedRow[], displayMode: 'aligned' | 'original'): void {
  if (displayMode === 'aligned') {
    rows.sort(
      (a, b) =>
        naturalCompare(a.label, b.label) ||
        (a.left?.index ?? Number.MAX_SAFE_INTEGER) -
          (b.left?.index ?? Number.MAX_SAFE_INTEGER) ||
        (a.right?.index ?? Number.MAX_SAFE_INTEGER) -
          (b.right?.index ?? Number.MAX_SAFE_INTEGER),
    );
  } else {
    rows.sort(
      (a, b) =>
        (a.left?.index ?? Number.MAX_SAFE_INTEGER) -
          (b.left?.index ?? Number.MAX_SAFE_INTEGER) ||
        (a.right?.index ?? Number.MAX_SAFE_INTEGER) -
          (b.right?.index ?? Number.MAX_SAFE_INTEGER),
    );
  }
}

function groupLabel(
  left: IndexedValue[] | undefined,
  right: IndexedValue[] | undefined,
): string {
  return previewValue(left?.[0]?.value ?? right?.[0]?.value);
}

function allObjects(values: unknown[]): boolean {
  return values.every(isJsonObject);
}

function allScalars(values: unknown[]): boolean {
  return values.every((value) => !Array.isArray(value) && !isJsonObject(value));
}

function allArrays(values: unknown[]): boolean {
  return values.every(Array.isArray);
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isLosslessNumber(value)
  );
}

function scalarEqual(left: unknown, right: unknown): boolean {
  if (isLosslessNumber(left) || isLosslessNumber(right)) {
    if (valueType(left) !== 'number' || valueType(right) !== 'number') return false;
    return exactNumberText(left) === exactNumberText(right);
  }
  return Object.is(left, right) || left === right;
}

function exactNumberText(value: unknown): string {
  return isLosslessNumber(value) ? value.toString() : String(value);
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (isLosslessNumber(value)) return 'number';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function previewValue(value: unknown, maxLength = 120): string {
  let text: string;
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (isLosslessNumber(value)) return value.toString();
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
  if (isJsonObject(value)) {
    const count = Object.keys(value).length;
    return `{${count} key${count === 1 ? '' : 's'}}`;
  }
  if (typeof value === 'string') text = JSON.stringify(value);
  else if (typeof value === 'number') text = String(value);
  else if (typeof value === 'boolean') text = String(value);
  else text = String(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function canonicalValue(value: unknown): string {
  if (value === null) return 'z';
  if (isLosslessNumber(value)) {
    const text = value.toString();
    return `n${text.length}:${text}`;
  }
  switch (typeof value) {
    case 'string':
      return `s${value.length}:${value}`;
    case 'number': {
      const text = String(value);
      return `n${text.length}:${text}`;
    }
    case 'boolean':
      return value ? 'b1' : 'b0';
    case 'undefined':
      return 'u';
    case 'object':
      if (Array.isArray(value)) {
        return `a${value.length}:[${value.map(canonicalValue).join(',')}]`;
      }
      if (isJsonObject(value)) {
        const keys = Object.keys(value).sort(naturalCompare);
        return `o${keys.length}:{${keys
          .map((key) => `${key.length}:${key}=${canonicalValue(value[key])}`)
          .join(',')}}`;
      }
      return `x:${String(value)}`;
    default:
      return `${typeof value}:${String(value)}`;
  }
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((key, index) => key === right[index])
  );
}

function naturalCompare(left: string, right: string): number {
  return naturalCollator.compare(left, right);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function roundMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// Retained as a named helper because rule/report normalization is part of the
// public contract, even though recursive locations already carry normalized paths.
export function normalizeSemanticPath(path: string): string {
  return normalizeReportedPath(path);
}
