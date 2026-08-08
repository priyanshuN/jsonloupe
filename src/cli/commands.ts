// The converter's command line (SPEC-converter.md §12 step 5): a frozen spec
// re-runs headless, with no UI and no model in the loop.
//
// Three verbs, matching the engine's three phases — look at a document, draft a
// mapping for it, run that mapping. The draft is written out for a human to
// read and edit; nothing here ever guesses on the user's behalf and then runs.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import {
  convert,
  csvTextSink,
  draftSpec,
  inspect,
  SpecInvalid,
  validateSpec,
  xlsxSink,
  type ConvertSpec,
  type SourceFormat,
  type SourceInput,
} from '../convert/index';

export const USAGE = `jsonloupe — convert nested JSON into flat tables

usage:
  jsonloupe inspect <file>                     what tables are in here?
  jsonloupe draft   <file> [-o spec.json]      write a starter mapping spec
  jsonloupe convert <file> --spec <spec.json> [-o out] [--to xlsx|csv]

  --format      override the input format (json | jsonl | csv); inferred from
                the extension otherwise
  --to          output format (xlsx | csv); the spec's own output format
                otherwise. Reading and writing get separate flags because csv
                is a legal answer to both questions
  --out, -o     output path. xlsx → a file; csv → a directory, one per table
  --base-date   draft only: what to date time-only columns against —
                a yyyy-MM-dd date, or "today". By default the draft looks for
                a date already in the document and only falls back to today

Everything runs locally. A spec is a small JSON document you can read, edit,
commit, and re-run — the same input plus the same spec is the same output.`;

interface Args {
  cmd: string;
  file?: string;
  spec?: string;
  out?: string;
  format?: SourceFormat;
  outFormat?: 'xlsx' | 'csv';
  baseDate?: string;
  rows: number;
}

function parse(argv: string[]): Args | { error: string } {
  const a: Args = { cmd: argv[0] ?? '', rows: 0 };
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--spec') a.spec = argv[++i];
    else if (v === '--out' || v === '-o') a.out = argv[++i];
    else if (v === '--rows') a.rows = Number(argv[++i]);
    else if (v === '--base-date') {
      const b = argv[++i];
      if (b !== 'today' && !/^\d{4}-\d{2}-\d{2}$/.test(b ?? '')) {
        return { error: `--base-date wants yyyy-MM-dd or "today", got \`${b}\`` };
      }
      a.baseDate = b;
    }
    else if (v === '--format') {
      const f = argv[++i];
      if (f !== 'json' && f !== 'jsonl' && f !== 'csv') {
        return { error: `--format reads the input and wants json, jsonl or csv, got \`${f}\`${f === 'xlsx' ? ' — to write xlsx, use --to' : ''}` };
      }
      a.format = f;
    }
    else if (v === '--to') {
      const f = argv[++i];
      if (f !== 'xlsx' && f !== 'csv') return { error: `--to writes the output and wants xlsx or csv, got \`${f}\`` };
      a.outFormat = f;
    } else if (v.startsWith('-')) return { error: `unknown option \`${v}\`` };
    else rest.push(v);
  }
  a.file = rest[0];
  if (!a.file) return { error: `${a.cmd} needs a file` };
  return a;
}

function formatOf(file: string, override?: SourceFormat): SourceFormat {
  if (override) return override;
  const ext = extname(file).toLowerCase();
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
  return 'json';
}

async function read(file: string, format: SourceFormat): Promise<SourceInput> {
  return { text: await readFile(resolve(file), 'utf8'), format };
}

/** Returns a process exit code. Everything user-facing prints here. */
export async function run(argv: string[]): Promise<number> {
  const a = parse(argv);
  if ('error' in a) {
    console.error(`jsonloupe: ${a.error}\n\n${USAGE}`);
    return 1;
  }

  const args = a as Args & { file: string };
  try {
    if (a.cmd === 'inspect') return await cmdInspect(args);
    if (a.cmd === 'draft') return await cmdDraft(args);
    if (a.cmd === 'convert') return await cmdConvert(args);
  } catch (err) {
    if (err instanceof SpecInvalid) {
      console.error(`jsonloupe: the spec is not valid (${err.errors.length} problem(s)):\n`);
      for (const e of err.errors) {
        console.error(`  ${e.at}`);
        console.error(`    ${e.message}${e.hint ? `  (did you mean \`${e.hint}\`?)` : ''}`);
      }
      return 2;
    }
    console.error(`jsonloupe: ${(err as Error)?.message ?? err}`);
    return 1;
  }
  console.error(`jsonloupe: unknown command \`${a.cmd}\`\n\n${USAGE}`);
  return 1;
}

async function cmdInspect(a: Args & { file: string }): Promise<number> {
  const fmt = formatOf(a.file, a.format);
  const ins = inspect(await read(a.file, fmt), fmt);
  if (!ins.tables.length) {
    console.log('no tables found — this document has no array or map of objects in it');
    return 0;
  }
  console.log(`${ins.tables.length} table(s) found${ins.truncated ? ' (row counts are lower bounds)' : ''}:\n`);
  for (const t of ins.tables) {
    console.log(`  ${t.name}  ${t.rows} row(s)`);
    console.log(`    anchor: ${t.anchor}`);
    if (t.parentAnchor) console.log(`    under:  ${t.parentAnchor}`);
    const fields = t.fields.filter((f) => !f.kinds.includes('object') && !f.kinds.includes('array'));
    for (const f of fields.slice(0, 40)) {
      const typed = f.suggest && 'type' in f.suggest ? `  → ${f.suggest.type}` : '';
      const amb = f.suggest && 'ambiguous' in f.suggest ? '  → ambiguous date, needs a choice' : '';
      const sample = f.samples[0] !== undefined ? `  e.g. ${JSON.stringify(f.samples[0])}` : '';
      console.log(`    · ${f.path}${sample}${typed}${amb}`);
    }
    if (fields.length > 40) console.log(`    … ${fields.length - 40} more`);
    console.log('');
  }
  return 0;
}

async function cmdDraft(a: Args & { file: string }): Promise<number> {
  const fmt = formatOf(a.file, a.format);
  const input = await read(a.file, fmt);
  const ins = inspect(input, fmt);
  const spec = draftSpec(ins, { output: a.outFormat ?? 'xlsx', baseDate: a.baseDate });
  const text = JSON.stringify(spec, null, 2);

  if (a.out) {
    await writeFile(resolve(a.out), text + '\n');
    console.error(`wrote ${a.out} — ${spec.tables.length} table(s). Read it before you run it.`);
    reportBaseDates(spec, !!a.baseDate);
    warnAboutAmbiguity(ins);
  } else {
    console.log(text);
  }
  return 0;
}

/**
 * Say where every time-only column got its date. `today` is the day the
 * conversion ran, not the day the data is about — on an overnight payload those
 * differ, and a user who is not told will not think to check.
 */
function reportBaseDates(spec: ConvertSpec, explicit: boolean): void {
  const dated = spec.tables.flatMap((t) =>
    t.columns.filter((c) => c.baseDate).map((c) => ({ table: t.name, col: c.name, base: c.baseDate! })),
  );
  if (!dated.length) return;
  const guessed = dated.filter((d) => d.base === 'today');
  for (const d of dated.filter((x) => x.base !== 'today')) {
    console.error(`  ${d.table}.${d.col}: dated from ${d.base}`);
  }
  if (guessed.length && !explicit) {
    const names = guessed.map((g) => `${g.table}.${g.col}`).join(', ');
    console.error(
      `  note: ${names} carry a time but no date, and this document has none to borrow — ` +
        `they will be dated TODAY. Pass --base-date yyyy-MM-dd if they belong to another day.`,
    );
  }
}

/** A draft is a guess the user is about to trust, so its soft spots are named. */
function warnAboutAmbiguity(ins: ReturnType<typeof inspect>): void {
  for (const t of ins.tables) {
    for (const f of t.fields) {
      if (f.suggest && 'ambiguous' in f.suggest) {
        console.error(
          `  note: ${t.name}.${f.path} looks like a date but day-vs-month is undecidable from the data ` +
            `(e.g. ${f.samples[0]}) — set \`parse\` yourself before converting`,
        );
      }
    }
  }
}

async function cmdConvert(a: Args & { file: string }): Promise<number> {
  if (!a.spec) {
    console.error('jsonloupe: convert needs --spec (run `jsonloupe draft` first)');
    return 1;
  }
  const spec = JSON.parse(await readFile(resolve(a.spec), 'utf8')) as ConvertSpec;
  const fmt = formatOf(a.file, a.format);
  const input = await read(a.file, fmt);

  // Validate against the real document before writing anything, so a path that
  // matches nothing is reported as the typo it is rather than an empty column.
  const ins = inspect(input, fmt);
  const check = validateSpec(spec, ins);
  if (!check.ok) throw new SpecInvalid(check.errors);

  const outFormat = a.outFormat ?? spec.output.format ?? 'xlsx';
  const stem = basename(a.file).replace(/\.[^.]+$/, '');

  if (outFormat === 'xlsx') {
    const sink = xlsxSink();
    const report = await convert(input, { ...spec, output: { ...spec.output, format: 'xlsx' } }, sink, { validated: true });
    const out = resolve(a.out ?? `${stem}.xlsx`);
    await writeFile(out, sink.bytes());
    printReport(report, [out]);
  } else {
    const sink = csvTextSink();
    const report = await convert(input, { ...spec, output: { ...spec.output, format: 'csv' } }, sink, { validated: true });
    const dir = resolve(a.out ?? `${stem}-tables`);
    await mkdir(dir, { recursive: true });
    const written: string[] = [];
    for (const f of sink.files) {
      const p = join(dir, f.name);
      await writeFile(p, f.text);
      written.push(p);
    }
    printReport(report, written);
  }
  return 0;
}

function printReport(report: Awaited<ReturnType<typeof convert>>, files: string[]): void {
  for (const t of report.tables) {
    const skipped = t.skipped ? `, ${t.skipped} row(s) skipped` : '';
    console.log(`  ${t.name}: ${t.rows} row(s)${skipped}`);
  }
  // A run that quietly dropped 4,000 values is not a successful run.
  for (const w of report.warnings) {
    const where = w.column ? `${w.table}.${w.column}` : w.table;
    const sample = w.sample !== undefined ? ` (e.g. ${JSON.stringify(w.sample)})` : '';
    console.log(`  warning: ${where} — ${w.code} on ${w.count} value(s)${sample}`);
  }
  for (const f of files) console.log(`wrote ${f}`);
}
