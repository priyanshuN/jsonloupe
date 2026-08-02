// The converter's public surface (SPEC-converter.md §9.2). Consumed unchanged
// by the browser worker, the Node MCP server and the CLI — zero DOM, zero I/O.

export { inspect, singular, type Inspection, type DetectedTable, type DetectedField, type Kind, type Suggestion } from './inspect';
export { draftSpec, parentLink, matchTarget, type DraftHints } from './draft';
export { validateSpec, ancestorAnchorOf } from './validate';
export {
  convert,
  preview,
  loadSource,
  parseCsv,
  iterateRows,
  resolveFrom,
  SpecInvalid,
  type SourceInput,
  type TableSink,
  type TableWriter,
  type ConvertReport,
  type PreviewResult,
  type RunOptions,
  type Warning,
  type Frame,
} from './engine';
export { memorySink, csvTextSink, xlsxSink, buildXlsx, zipTextFiles, crc32, colRef, sheetName, type CapturedTable } from './sinks';
export {
  parseAnchor,
  parseFrom,
  formatAnchor,
  anchorDepth,
  isAnchorPrefix,
  type ConvertSpec,
  type TableSpec,
  type ColumnSpec,
  type OutputSpec,
  type SourceFormat,
  type GeoForm,
  type SpecError,
  type ErrCode,
  type ValidationResult,
  type AnchorSeg,
  type FromSeg,
  type FromPath,
} from './spec';
export {
  cellText,
  parseGeo,
  parseNaive,
  renderNaive,
  compileFormat,
  needsBaseDate,
  parseBaseDate,
  toNum,
  isScalar,
  today,
  EPOCH_TOKENS,
  type Naive,
  type GeoPoint,
} from './coerce';
