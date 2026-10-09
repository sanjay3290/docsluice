import type { Budget } from '../../core/budget.js';
import type { WarningSink } from '../../core/warnings.js';

/** Formula attributes captured from one worksheet `<f>` element. */
export interface XlsxFormulaMetadata {
  type?: string;
  sharedIndex?: string;
  ref?: string;
  text: string;
}

interface SharedFormulaMaster {
  address: string;
  range: CellRange;
  text: string;
}

const MAX_FORMULA_TEXT_CHARS = 2_000_000;
const MAX_SHARED_FORMULA_MASTERS = 100_000;
const MAX_SHARED_FORMULA_TEXT_CHARS = 20_000_000;

/**
 * Associates worksheet formulas with shared-formula masters without evaluating them.
 * Register formula metadata during the first pass, then resolve it during the second.
 */
export class XlsxFormulaResolver {
  readonly #budget: Budget;
  readonly #warnings: WarningSink;
  readonly #loc?: { path?: string };
  readonly #masters = new Map<string, SharedFormulaMaster | null>();
  #sharedFormulaTextChars = 0;
  #warnedMissingCache = false;
  #warnedSharedFormula = false;
  #warnedFormulaText = false;

  constructor(budget: Budget, warnings: WarningSink, loc?: { path?: string }) {
    this.#budget = budget;
    this.#warnings = warnings;
    this.#loc = loc;
  }

  /** Stage a formula so shared dependents can be resolved even when the master is later. */
  register(address: string, metadata: XlsxFormulaMetadata): void {
    this.#budget.tick();
    if (metadata.type !== 'shared') return;

    const sharedIndex = canonicalSharedIndex(metadata.sharedIndex, this.#budget);
    if (sharedIndex === undefined) {
      this.#warnSharedFormula();
      return;
    }

    // A `ref` marks the shared master. Dependents only carry the shared index.
    if (metadata.ref === undefined) return;
    const addressCoordinates = parseCellAddress(address, this.#budget);
    const range = parseCellRange(metadata.ref, this.#budget);
    if (
      !addressCoordinates ||
      !range ||
      !sameCell(addressCoordinates, range.start) ||
      typeof metadata.text !== 'string'
    ) {
      this.#poisonSharedFormula(sharedIndex);
      this.#warnSharedFormula();
      return;
    }
    if (metadata.text.length > MAX_FORMULA_TEXT_CHARS) {
      this.#poisonSharedFormula(sharedIndex);
      this.#warnFormulaText();
      return;
    }

    if (this.#masters.has(sharedIndex)) {
      const existing = this.#masters.get(sharedIndex);
      if (
        existing &&
        existing.address === address &&
        sameRange(existing.range, range) &&
        existing.text === metadata.text
      )
        return;
      this.#poisonSharedFormula(sharedIndex);
      this.#warnSharedFormula();
      return;
    }
    if (this.#masters.size >= MAX_SHARED_FORMULA_MASTERS) {
      this.#warnSharedFormula();
      return;
    }
    if (metadata.text.length > MAX_SHARED_FORMULA_TEXT_CHARS - this.#sharedFormulaTextChars) {
      this.#poisonSharedFormula(sharedIndex);
      this.#warnFormulaText();
      return;
    }
    this.#masters.set(sharedIndex, { address, range, text: metadata.text });
    this.#sharedFormulaTextChars += metadata.text.length;
  }

  /** Return optional formula text; cached cell text remains the caller's responsibility. */
  resolve(
    address: string,
    metadata: XlsxFormulaMetadata,
    hasCachedValue: boolean,
    formulasEnabled: boolean,
  ): string | undefined {
    this.#budget.tick();
    if (!hasCachedValue && !this.#warnedMissingCache) {
      this.#warnedMissingCache = true;
      this.#warnings.add({
        code: 'UNREADABLE_PART',
        message: 'A worksheet formula cell has no cached value.',
        ...(this.#loc?.path ? { loc: { path: this.#loc.path } } : {}),
      });
    }
    if (!formulasEnabled) return undefined;

    if (metadata.type !== 'shared') {
      const text = boundedFormulaText(metadata.text, this.#warnFormulaText);
      return text === undefined ? undefined : this.#retainFormulaText(text);
    }

    const sharedIndex = canonicalSharedIndex(metadata.sharedIndex, this.#budget);
    if (sharedIndex === undefined) {
      this.#warnSharedFormula();
      return undefined;
    }

    if (metadata.ref !== undefined) {
      const master = this.#masters.get(sharedIndex);
      if (!master || master.address !== address) {
        this.#warnSharedFormula();
        return undefined;
      }
      return this.#retainFormulaText(master.text);
    }

    const master = this.#masters.get(sharedIndex);
    const coordinates = parseCellAddress(address, this.#budget);
    if (!master || !coordinates || !containsCell(master.range, coordinates)) {
      this.#warnSharedFormula();
      return undefined;
    }
    return this.#retainFormulaText(master.text);
  }

  /** Charge only formula text that the caller will retain in an output cell. */
  #retainFormulaText(text: string): string | undefined {
    if (!this.#budget.checkOutputChars(text.length)) return undefined;
    if (!this.#budget.addOutputChars(text.length)) return undefined;
    return text;
  }

  #poisonSharedFormula(sharedIndex: string): void {
    if (this.#masters.has(sharedIndex)) {
      this.#masters.set(sharedIndex, null);
    } else if (this.#masters.size < MAX_SHARED_FORMULA_MASTERS) {
      this.#masters.set(sharedIndex, null);
    }
  }

  #warnSharedFormula = (): void => {
    if (this.#warnedSharedFormula) return;
    this.#warnedSharedFormula = true;
    this.#warnings.add({
      code: 'UNREADABLE_PART',
      message: 'A worksheet shared formula could not be associated.',
      ...(this.#loc?.path ? { loc: { path: this.#loc.path } } : {}),
    });
  };

  #warnFormulaText = (): void => {
    if (this.#warnedFormulaText) return;
    this.#warnedFormulaText = true;
    this.#warnings.add({
      code: 'UNREADABLE_PART',
      message: 'A worksheet formula exceeded the bounded reader capacity.',
      ...(this.#loc?.path ? { loc: { path: this.#loc.path } } : {}),
    });
  };
}

function boundedFormulaText(text: string, warn: () => void): string | undefined {
  if (typeof text !== 'string' || text.length > MAX_FORMULA_TEXT_CHARS) {
    warn();
    return undefined;
  }
  return text;
}

interface CellCoordinates {
  row: number;
  column: number;
}

interface CellRange {
  start: CellCoordinates;
  end: CellCoordinates;
}

function parseCellAddress(value: string, budget: Budget): CellCoordinates | undefined {
  if (value.length === 0 || value.length > 16 || value.includes(':')) return undefined;
  return parseCellPart(value, 0, value.length, budget);
}

function parseCellRange(value: string, budget: Budget): CellRange | undefined {
  if (value.length === 0 || value.length > 32) return undefined;
  const separator = value.indexOf(':');
  if (separator < 0) {
    const cell = parseCellPart(value, 0, value.length, budget);
    return cell ? { start: cell, end: cell } : undefined;
  }
  if (value.indexOf(':', separator + 1) >= 0) return undefined;
  const start = parseCellPart(value, 0, separator, budget);
  const end = parseCellPart(value, separator + 1, value.length, budget);
  if (!start || !end || end.row < start.row || end.column < start.column) return undefined;
  return { start, end };
}

function sameCell(left: CellCoordinates, right: CellCoordinates): boolean {
  return left.row === right.row && left.column === right.column;
}

function sameRange(left: CellRange, right: CellRange): boolean {
  return sameCell(left.start, right.start) && sameCell(left.end, right.end);
}

function containsCell(range: CellRange, cell: CellCoordinates): boolean {
  return (
    cell.row >= range.start.row &&
    cell.row <= range.end.row &&
    cell.column >= range.start.column &&
    cell.column <= range.end.column
  );
}

function parseCellPart(
  value: string,
  start: number,
  end: number,
  budget: Budget,
): CellCoordinates | undefined {
  let cursor = start;
  let column = 0;
  while (cursor < end) {
    budget.tick();
    const code = value.charCodeAt(cursor);
    if (code < 65 || code > 90) break;
    column = column * 26 + code - 64;
    if (column > 16_384) return undefined;
    cursor += 1;
  }
  if (cursor === start || cursor === end) return undefined;

  let row = 0;
  while (cursor < end) {
    budget.tick();
    const code = value.charCodeAt(cursor);
    if (code < 48 || code > 57) return undefined;
    row = row * 10 + code - 48;
    if (row > 1_048_576) return undefined;
    cursor += 1;
  }
  return row > 0 ? { row, column } : undefined;
}

function canonicalSharedIndex(value: string | undefined, budget: Budget): string | undefined {
  if (value === undefined || value.length === 0 || value.length > 16) return undefined;
  let numeric = 0;
  for (let index = 0; index < value.length; index += 1) {
    budget.tick();
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    numeric = numeric * 10 + code - 48;
    if (!Number.isSafeInteger(numeric)) return undefined;
  }
  return String(numeric);
}
