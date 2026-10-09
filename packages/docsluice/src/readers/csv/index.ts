import type { Cell, FormatId } from '../../core/model.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import type { Budget } from '../../core/budget.js';
import type { WarningSink } from '../../core/warnings.js';
import { decodeText, detectEncoding, type TextEncoding } from '../../detect/encoding.js';

const MAX_COLUMNS = 16_384;
const MAX_QUOTED_CHARS = 1_000_000;
const SNIFF_BYTES = 8 * 1024;
const DECODE_CHUNK_BYTES = 64 * 1024;
const STREAM_DECODE_BYTES = 8 * 1024;
const STREAM_BATCH_ROWS = 1_000;
const DELIMITERS = [',', ';', '\t', '|'] as const;

type RowHandler = (row: string[]) => boolean | void;

/** Incremental CSV tokenizer. State, including a pending CR, survives write() boundaries. */
export class IncrementalDelimitedParser {
  readonly #delimiter: string;
  readonly #onRow: RowHandler;
  #fieldParts: string[] = [];
  #row: string[] = [];
  #recordPresent = false;
  #fieldLength = 0;
  #inQuotes = false;
  #afterQuote = false;
  #pendingCr = false;
  #stopped = false;
  malformed = false;
  limited = false;

  constructor(delimiter: string, onRow: RowHandler, maxFieldChars = Number.MAX_SAFE_INTEGER) {
    if (delimiter.length !== 1) throw new RangeError('Delimiter must be one character.');
    this.#delimiter = delimiter;
    this.#onRow = onRow;
    this.#maxFieldChars = maxFieldChars;
  }

  readonly #maxFieldChars: number;

  write(chunk: string, final = false, tick: () => void = () => {}): boolean {
    if (this.#stopped) return false;
    for (let index = 0; index < chunk.length; index += 1) {
      tick();
      const character = chunk[index]!;
      if (this.#pendingCr) {
        this.#pendingCr = false;
        if (character === '\n') continue;
      }
      if (this.#inQuotes) {
        if (this.#afterQuote) {
          if (character === '"') {
            this.#append('"');
            this.#afterQuote = false;
            if (this.limited) {
              this.#endRow();
              this.#stopped = true;
              break;
            }
            continue;
          }
          this.#inQuotes = false;
          this.#afterQuote = false;
          if (character === this.#delimiter) {
            this.#endField();
            continue;
          }
          if (character === '\r' || character === '\n') {
            this.#endRow();
            if (character === '\r') this.#pendingCr = true;
            if (this.#stopped) break;
            continue;
          }
          // A quote followed by ordinary text is malformed. Treat it as a closing
          // quote and resume at the current character to avoid swallowing rows.
          this.malformed = true;
        } else if (character === '"') {
          this.#afterQuote = true;
          continue;
        } else {
          this.#append(character);
          if (this.limited) {
            this.#endRow();
            this.#stopped = true;
            break;
          }
          if (this.#fieldLength > MAX_QUOTED_CHARS && (character === '\n' || character === '\r')) {
            this.#inQuotes = false;
            this.malformed = true;
            this.#endRow();
            if (this.#stopped) break;
          }
          continue;
        }
      }
      if (character === this.#delimiter) {
        this.#recordPresent = true;
        this.#endField();
        continue;
      }
      if (character === '\r' || character === '\n') {
        this.#endRow();
        if (character === '\r') this.#pendingCr = true;
        if (this.#stopped) break;
        continue;
      }
      if (character === '"' && this.#fieldLength === 0 && this.#fieldParts.length === 0) {
        this.#inQuotes = true;
        this.#recordPresent = true;
        continue;
      }
      this.#append(character);
      if (this.limited) {
        this.#endRow();
        this.#stopped = true;
        break;
      }
    }
    if (final) {
      if (this.#inQuotes) {
        if (!this.#afterQuote) this.malformed = true;
        this.#inQuotes = false;
        this.#afterQuote = false;
      }
      if (this.#recordPresent || this.#fieldLength > 0 || this.#fieldParts.length > 0 || this.#row.length > 0)
        this.#endRow();
    }
    return !this.#stopped;
  }

  #append(character: string): void {
    this.#recordPresent = true;
    this.#fieldParts.push(character);
    this.#fieldLength += character.length;
    if (this.#fieldLength > this.#maxFieldChars) this.limited = true;
  }

  #endField(): void {
    if (this.#row.length < MAX_COLUMNS) this.#row.push(this.#fieldParts.join(''));
    else this.malformed = true;
    this.#fieldParts = [];
    this.#fieldLength = 0;
  }

  #endRow(): void {
    this.#endField();
    if (this.#recordPresent) {
      if (this.#onRow(this.#row) === false) this.#stopped = true;
    }
    this.#row = [];
    this.#recordPresent = false;
  }
}

/** Parse text chunks with delimiter state preserved across arbitrary chunk edges. */
export function parseDelimitedChunks(chunks: Iterable<string>, delimiter: string): string[][] {
  const rows: string[][] = [];
  const parser = new IncrementalDelimitedParser(delimiter, (row) => {
    rows.push(row);
  });
  for (const chunk of chunks) {
    parser.write(chunk);
  }
  parser.write('', true);
  return rows;
}

/** Parse UTF-8 byte chunks while preserving decoder state across split code points. */
export function parseDelimitedByteChunks(chunks: Iterable<Uint8Array>, delimiter: string): string[][] {
  const rows: string[][] = [];
  const parser = new IncrementalDelimitedParser(delimiter, (row) => {
    rows.push(row);
  });
  const decoder = new TextDecoder('utf-8');
  for (const chunk of chunks) parser.write(decoder.decode(chunk, { stream: true }));
  parser.write(decoder.decode(), true);
  return rows;
}

/** The stream adapter shape used by the CSV helper until the core stream API lands. */
export interface DelimitedStreamInput {
  readonly prefix: Uint8Array;
  /** Yields the complete source, including `prefix` bytes. */
  chunks(): AsyncIterable<Uint8Array>;
}

/** Small output surface needed by incremental CSV extraction and bounded test sinks. */
export interface DelimitedStreamContext {
  readonly budget: Budget;
  readonly warnings: WarningSink;
  readonly path: string;
  readonly out: {
    setEncoding(encoding: TextEncoding): void;
    table(rows: Cell[][], headerRows: number, loc?: { path?: string; range?: string }): boolean;
  };
}

/**
 * Parse a stream into at most 1,000-row tables. The input's chunks() iterable must
 * yield the whole source, including bytes in prefix; prefix is only used for sniffing.
 */
export async function readDelimitedStream(
  ctx: DelimitedStreamContext,
  input: DelimitedStreamInput,
  flush: () => Promise<void>,
  delimiter?: string,
): Promise<number> {
  ctx.budget.tick();
  const detected = detectEncoding(input.prefix);
  if (!detected.isText || detected.encoding === 'unsupported') return 0;
  ctx.out.setEncoding(detected.encoding);
  if (detected.warning)
    ctx.warnings.add({ code: detected.warning, message: 'Text encoding was inferred from the byte sample.' });
  const sampleText = decodeText(input.prefix.subarray(0, SNIFF_BYTES), detected.encoding);
  const sniffText = sampleText.charCodeAt(0) === 0xfeff ? sampleText.slice(1) : sampleText;
  const chosen = delimiter ?? sniffDelimiter(sniffText, () => ctx.budget.tick());
  const decoder = new TextDecoder(detected.encoding);
  const pendingRows: string[][] = [];
  let pendingChars = 0;
  let emittedRows = 0;
  let parseStopped = false;
  let cellStopped = false;
  const parser = new IncrementalDelimitedParser(
    chosen,
    (row) => {
      ctx.budget.tick();
      const rowChars = row.reduce((sum, cell) => sum + cell.length, 0);
      if (!ctx.budget.checkOutputChars(pendingChars + rowChars)) {
        parseStopped = true;
        return false;
      }
      pendingRows.push(row);
      pendingChars += rowChars;
      return true;
    },
    Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars),
  );

  const emitPending = async (final = false): Promise<boolean> => {
    let offset = 0;
    while (pendingRows.length - offset >= (final ? 1 : STREAM_BATCH_ROWS)) {
      ctx.budget.tick();
      const batch = pendingRows.slice(offset, offset + STREAM_BATCH_ROWS);
      let width = 0;
      for (const row of batch) {
        ctx.budget.tick();
        width = Math.max(width, row.length);
      }
      const available = Math.max(0, ctx.budget.limits.cells - ctx.budget.cells);
      const acceptedRows = Math.min(batch.length, width === 0 ? 0 : Math.floor(available / width));
      if (acceptedRows > 0) {
        const acceptedCells = acceptedRows * width;
        if (!ctx.budget.addCells(acceptedCells)) return false;
        const cells: Cell[][] = [];
        for (let rowIndex = 0; rowIndex < acceptedRows; rowIndex += 1) {
          ctx.budget.tick();
          const sourceRow = batch[rowIndex]!;
          const outputRow: Cell[] = [];
          for (let column = 0; column < width; column += 1) {
            ctx.budget.tick();
            outputRow.push({
              text: sourceRow[column] ?? '',
              address: `${columnName(column + 1)}${emittedRows + rowIndex + 1}`,
            });
          }
          cells.push(outputRow);
        }
        const startRow = emittedRows + 1;
        const endRow = emittedRows + acceptedRows;
        const endColumn = columnName(width);
        const loc = {
          range: `A${startRow}:${endColumn}${endRow}`,
          ...(ctx.path.length > 0 ? { path: ctx.path } : {}),
        };
        if (!ctx.out.table(cells, 0, loc)) {
          parseStopped = true;
          return false;
        }
        emittedRows += acceptedRows;
        for (let rowIndex = 0; rowIndex < acceptedRows; rowIndex += 1) {
          const row = batch[rowIndex]!;
          pendingChars -= row.reduce((sum, cell) => sum + cell.length, 0);
        }
        if (acceptedRows < batch.length) {
          ctx.budget.addCells(width);
          cellStopped = true;
          parseStopped = true;
          pendingRows.splice(0, offset + acceptedRows);
          await flush();
          return false;
        }
        offset += acceptedRows;
        await flush();
      } else {
        ctx.budget.addCells(Math.max(width, 1));
        cellStopped = true;
        parseStopped = true;
        return false;
      }
    }
    if (offset > 0) pendingRows.splice(0, offset);
    return true;
  };

  let complete = true;
  outer: for await (const sourceChunk of input.chunks()) {
    for (let offset = 0; offset < sourceChunk.length; offset += STREAM_DECODE_BYTES) {
      ctx.budget.tick();
      const end = Math.min(sourceChunk.length, offset + STREAM_DECODE_BYTES);
      const text = decoder.decode(sourceChunk.subarray(offset, end), { stream: true });
      if (!parser.write(text, false, () => ctx.budget.tick())) complete = false;
      const emitted = await emitPending(!complete);
      await flush();
      if (!emitted) complete = false;
      if (!complete) break outer;
    }
  }
  if (complete) {
    const finalText = decoder.decode();
    parser.write(finalText, true, () => ctx.budget.tick());
    await emitPending(true);
    await flush();
  }
  if (parser.malformed)
    ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'Malformed CSV quoting was recovered.' });
  if (parseStopped || cellStopped) {
    ctx.warnings.add({
      code: 'TRUNCATED',
      message: `CSV stream stopped after ${emittedRows} rows; additional rows may have been skipped.`,
    });
  }
  return emittedRows;
}

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

function readCsv(ctx: ReadContext, delimiter?: string): void {
  ctx.budget.tick();
  const encoding = detectEncoding(ctx.bytes);
  if (!encoding.isText || encoding.encoding === 'unsupported') return;
  ctx.out.setEncoding(encoding.encoding);
  if (encoding.warning)
    ctx.warnings.add({
      code: encoding.warning,
      message: 'Text encoding was inferred from the byte sample.',
    });
  const sample = decodeText(ctx.bytes.subarray(0, SNIFF_BYTES), encoding.encoding);
  const sniffText = sample.charCodeAt(0) === 0xfeff ? sample.slice(1) : sample;
  const chosen = delimiter ?? sniffDelimiter(sniffText, () => ctx.budget.tick());
  const rows: string[][] = [];
  const maxCells = ctx.budget.limits.cells;
  let stagedCells = 0;
  let stagedChars = 0;
  let parseTruncated = false;
  let cellTruncated = false;
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
      if (accepted.length > 0) rows.push(accepted);
      if (parseTruncated) return false;
      return true;
    },
    Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars),
  );
  const decoder = new TextDecoder(encoding.encoding);
  let completed = true;
  for (let offset = 0; offset < ctx.bytes.length; offset += DECODE_CHUNK_BYTES) {
    ctx.budget.tick();
    const end = Math.min(ctx.bytes.length, offset + DECODE_CHUNK_BYTES);
    const decoded = decoder.decode(ctx.bytes.subarray(offset, end), { stream: true });
    if (!parser.write(decoded, false, () => ctx.budget.tick())) {
      completed = false;
      break;
    }
  }
  if (completed) parser.write(decoder.decode(), true, () => ctx.budget.tick());
  if (parser.malformed)
    ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'Malformed CSV quoting was recovered.' });
  if (rows.length === 0) {
    if (cellTruncated) ctx.budget.addCells(1);
    return;
  }
  let width = 0;
  for (const row of rows) {
    ctx.budget.tick();
    width = Math.max(width, row.length);
  }
  const cells: Cell[][] = [];
  let stopped = false;
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
      output.push({ text: values[column] ?? '', address: `${columnName(column + 1)}${rowIndex + 1}` });
    }
    if (output.length > 0) cells.push(output);
  }
  if (cellTruncated && !stopped) {
    ctx.budget.addCells(1);
    stopped = true;
  }
  if (stopped && !ctx.budget.truncated) return;
  const emitted = ctx.out.table(cells, 0, ctx.path ? { path: ctx.path } : {});
  if (!emitted) return;
  if (parseTruncated || stopped) {
    ctx.warnings.add({
      code: 'TRUNCATED',
      message: `CSV stopped after ${cells.length} rows; additional rows may have been skipped.`,
    });
  }
}

function createReader(id: FormatId, delimiter?: string): Reader {
  return {
    id,
    mimeTypes: id === 'tsv' ? ['text/tab-separated-values'] : ['text/csv', 'text/comma-separated-values'],
    read(ctx: ReadContext): Promise<void> {
      return Promise.resolve().then(() => readCsv(ctx, delimiter));
    },
  };
}

/** CSV reader with bounded delimiter sniffing and RFC 4180 field handling. */
export const reader = createReader('csv');
export const csvReader = reader;
/** TSV reader that always uses a tab delimiter. */
export const tsvReader = createReader('tsv', '\t');

export default reader;
