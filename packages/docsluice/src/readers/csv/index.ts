import type { Cell, FormatId } from '../../core/model.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import { decodeText } from '../../detect/encoding.js';
import { detectTextInput } from '../text-input.js';
import { IncrementalDelimitedParser } from './parser.js';

const SNIFF_BYTES = 8 * 1024;
const DECODE_CHUNK_BYTES = 64 * 1024;
const DELIMITERS = [',', ';', '\t', '|'] as const;

function sniffDelimiter(text: string, tick: () => void): string {
  const lines: number[][] = [];
  let counts = [0, 0, 0, 0];
  let quoted = false;
  let fieldStart = true;
  let lineHasData = false;
  for (let index = 0; index < text.length && lines.length < 50; index += 1) {
    tick();
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') index += 1;
        else quoted = false;
      }
      if (character !== '\r' && character !== '\n') lineHasData = true;
      continue;
    }
    if (character === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
      lineHasData = true;
      continue;
    }
    const candidate = DELIMITERS.indexOf(character as (typeof DELIMITERS)[number]);
    if (candidate >= 0) {
      counts[candidate] = (counts[candidate] ?? 0) + 1;
      fieldStart = true;
      lineHasData = true;
      continue;
    }
    if (character === '\r' || character === '\n') {
      if (lineHasData) lines.push(counts);
      counts = [0, 0, 0, 0];
      fieldStart = true;
      lineHasData = false;
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      continue;
    }
    fieldStart = false;
    if (character !== ' ' && character !== '\t') lineHasData = true;
  }
  if (lineHasData && lines.length < 50) lines.push(counts);
  let best = ',';
  let bestScore = 0;
  for (let candidate = 0; candidate < DELIMITERS.length; candidate += 1) {
    const frequencies = new Map<number, number>();
    for (const row of lines) {
      const count = row[candidate] ?? 0;
      if (count > 0) frequencies.set(count, (frequencies.get(count) ?? 0) + 1);
    }
    let score = 0;
    for (const frequency of frequencies.values()) score = Math.max(score, frequency);
    if (score > bestScore) {
      bestScore = score;
      best = DELIMITERS[candidate]!;
    }
  }
  return best;
}

function columnName(column: number): string {
  let name = '';
  while (column > 0) {
    const remainder = (column - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    column = Math.floor((column - 1) / 26);
  }
  return name;
}

/** Rows per table: large files become several tables, emitted while the rest is still being parsed. */
const BATCH_ROWS = 1_000;

async function readCsv(ctx: ReadContext, delimiter?: string): Promise<void> {
  ctx.budget.tick();
  const encoding = detectTextInput(ctx);
  if (encoding === undefined) return;
  const sample = decodeText(ctx.bytes.subarray(0, SNIFF_BYTES), encoding);
  const sniffText = sample.charCodeAt(0) === 0xfeff ? sample.slice(1) : sample;
  const chosen = delimiter ?? sniffDelimiter(sniffText, () => ctx.budget.tick());
  const pending: string[][] = [];
  const maxCells = ctx.budget.limits.cells;
  let stagedCells = 0;
  let stagedChars = 0;
  let parseTruncated = false;
  let cellTruncated = false;
  let emittedRows = 0;
  let stopped = false;
  const parser = new IncrementalDelimitedParser(
    chosen,
    (row) => {
      ctx.budget.tick();
      let accepted = row;
      const remaining = Math.max(0, maxCells - ctx.budget.cells - stagedCells);
      if (row.length > remaining) {
        accepted = row.slice(0, remaining);
        parseTruncated = true;
        cellTruncated = true;
      }
      const rowChars = accepted.reduce((sum, cell) => sum + cell.length, 0);
      if (!ctx.budget.checkOutputChars(stagedChars + rowChars)) {
        parseTruncated = true;
        return false;
      }
      stagedCells += accepted.length;
      stagedChars += rowChars;
      if (accepted.length > 0) pending.push(accepted);
      if (parseTruncated) return false;
      return true;
    },
    Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars),
  );

  /** Emit one table of rows, padded to the widest row. Returns false once output must stop. */
  const emitRows = (rows: string[][]): boolean => {
    let width = 0;
    for (const row of rows) {
      ctx.budget.tick();
      width = Math.max(width, row.length);
      stagedCells -= row.length;
      stagedChars -= row.reduce((sum, cell) => sum + cell.length, 0);
    }
    const cells: Cell[][] = [];
    for (let rowIndex = 0; rowIndex < rows.length && !stopped; rowIndex += 1) {
      ctx.budget.tick();
      const values = rows[rowIndex]!;
      const output: Cell[] = [];
      for (let column = 0; column < width; column += 1) {
        ctx.budget.tick();
        if (!ctx.budget.addCells(1)) {
          stopped = true;
          break;
        }
        output.push({
          text: values[column] ?? '',
          address: `${columnName(column + 1)}${emittedRows + rowIndex + 1}`,
        });
      }
      if (output.length > 0) cells.push(output);
    }
    if (stopped && !ctx.budget.truncated) return false;
    if (cells.length === 0) return !stopped;
    emittedRows += cells.length;
    if (!ctx.out.table(cells, 0, ctx.path ? { path: ctx.path } : {})) {
      stopped = true;
      return false;
    }
    return !stopped;
  };

  const decoder = new TextDecoder(encoding);
  let completed = true;
  for (let offset = 0; offset < ctx.bytes.length && !stopped; offset += DECODE_CHUNK_BYTES) {
    ctx.budget.tick();
    const end = Math.min(ctx.bytes.length, offset + DECODE_CHUNK_BYTES);
    const decoded = decoder.decode(ctx.bytes.subarray(offset, end), { stream: true });
    const more = parser.write(decoded, false, () => ctx.budget.tick());
    while (pending.length >= BATCH_ROWS && !stopped) {
      if (!emitRows(pending.splice(0, BATCH_ROWS))) break;
      // A streaming consumer can apply backpressure between tables (EXT-2).
      await ctx.out.flush();
    }
    if (!more) {
      completed = false;
      break;
    }
  }
  if (completed && !stopped) parser.write(decoder.decode(), true, () => ctx.budget.tick());
  if (parser.malformed)
    ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'Malformed CSV quoting was recovered.' });
  while (pending.length > 0 && !stopped) {
    if (!emitRows(pending.splice(0, BATCH_ROWS))) break;
    await ctx.out.flush();
  }
  if (emittedRows === 0 && !stopped) {
    if (cellTruncated) ctx.budget.addCells(1);
    return;
  }
  if (cellTruncated && !stopped) {
    ctx.budget.addCells(1);
    stopped = true;
  }
  if (stopped && !ctx.budget.truncated) return;
  if (parseTruncated || stopped) {
    ctx.warnings.add({
      code: 'TRUNCATED',
      message: `CSV kept ${emittedRows} rows; the remaining rows were not read.`,
    });
  }
}

function createReader(id: FormatId, delimiter?: string): Reader {
  return {
    id,
    mimeTypes: id === 'tsv' ? ['text/tab-separated-values'] : ['text/csv', 'text/comma-separated-values'],
    read(ctx: ReadContext): Promise<void> {
      return readCsv(ctx, delimiter);
    },
  };
}

/** CSV reader with bounded delimiter sniffing and RFC 4180 field handling. */
export const csvReader = createReader('csv');
/** TSV reader that always uses a tab delimiter. */
export const tsvReader = createReader('tsv', '\t');
