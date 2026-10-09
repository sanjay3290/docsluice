const MAX_COLUMNS = 16_384;
/** An open quote longer than this is closed at the next line break, so a stray quote cannot swallow the file. */
const MAX_QUOTED_CHARS = 1_000_000;

export type RowHandler = (row: string[]) => boolean | void;

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
          const end =
            character === '\n' || character === '\r' ? index + 1 : this.#runEnd(chunk, index, '"', tick);
          this.#append(chunk.slice(index, end));
          index = end - 1;
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
      const end = this.#runEnd(chunk, index, this.#delimiter, tick);
      this.#append(chunk.slice(index, end));
      index = end - 1;
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

  /**
   * End of the run of ordinary characters starting at `start`: it stops before `stop`, CR or LF,
   * and at one character past the field limit so `limited` trips exactly as per-character appends would.
   */
  #runEnd(chunk: string, start: number, stop: string, tick: () => void): number {
    const limit = Math.min(chunk.length, start + Math.max(1, this.#maxFieldChars - this.#fieldLength + 1));
    let end = start + 1;
    while (end < limit) {
      const character = chunk[end];
      if (character === stop || character === '\r' || character === '\n') break;
      tick();
      end += 1;
    }
    return end;
  }

  #append(text: string): void {
    this.#recordPresent = true;
    this.#fieldParts.push(text);
    this.#fieldLength += text.length;
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
