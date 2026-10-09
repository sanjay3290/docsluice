import type { Budget } from '../../core/budget.js';
import { LimitExceededError } from '../../core/errors.js';
import type { WarningSink } from '../../core/warnings.js';
import { scanXml } from '../../xml/index.js';
import type { XmlContext } from '../../xml/index.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const structuralBudgets = new WeakMap<Budget, Budget>();
// Includes retained cells plus bounded row/column/table staging; sized for 100k ordinary rows.
const MAX_XLSX_OBJECTS = 1_500_000;
const MAX_SHARED_STRING_ENTRIES = 500_000;
const MAX_SHARED_STRING_CHARS = 20_000_000;

/** Tracks text already staged for output without charging the output counter twice. */
export class XlsxTextStaging {
  readonly #budget: Budget;
  #reservedOutputChars = 0;
  #objects = 0;

  constructor(budget: Budget) {
    this.#budget = budget;
  }

  get reservedOutputChars(): number {
    return this.#reservedOutputChars;
  }

  canReserveOutputChars(amount: number): boolean {
    if (!Number.isSafeInteger(amount) || amount < 0) return false;
    return this.#budget.checkOutputChars(this.#reservedOutputChars + amount);
  }

  reserveOutputChars(amount: number): boolean {
    if (!this.canReserveOutputChars(amount)) return false;
    this.#reservedOutputChars += amount;
    return true;
  }

  /** Reserve one bounded in-memory object before retaining it from workbook input. */
  reserveObjects(amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_XLSX_OBJECTS - this.#objects)
      throw new LimitExceededError('xlsxObjects', MAX_XLSX_OBJECTS);
    this.#objects += amount;
  }
}

/** Keep XML structural work on the shared budget while letting XLSX bound captured text itself. */
export function xlsxStagingXmlContext(budget: Budget, warnings: WarningSink, path?: string): XmlContext {
  let structuralBudget = structuralBudgets.get(budget);
  if (!structuralBudget) {
    structuralBudget = {
      tick: () => budget.tick(),
      enterDepth: (kind: 'xml' | 'block' | 'child') => budget.enterDepth(kind),
      exitDepth: (kind: 'xml' | 'block' | 'child') => budget.exitDepth(kind),
      checkOutputChars: () => true,
    } as unknown as Budget;
    structuralBudgets.set(budget, structuralBudget);
  }
  return { budget: structuralBudget, warnings, ...(path ? { path } : {}) };
}

/** Read shared strings in document order, flattening rich-text runs into plain text. */
export function readSharedStrings(
  bytes: Uint8Array,
  budget: Budget,
  warnings: WarningSink,
  path?: string,
  staging = new XlsxTextStaging(budget),
): string[] {
  const strings: string[] = [];
  let inRoot = false;
  let inItem = false;
  let inText = false;
  let inPhonetic = false;
  let pieces: string[] = [];
  let charCount = 0;
  let storedChars = 0;
  let storedEntries = 0;
  let malformed = false;
  const stack: Array<{ localName: string; namespaceURI?: string }> = [];
  scanXml(
    bytes,
    {
      onOpen(_name, _attrs, info) {
        budget.tick();
        if (!inRoot) {
          if (stack.length > 0 || info.localName !== 'sst' || info.namespaceURI !== MAIN) malformed = true;
          else inRoot = true;
        }
        const parent = stack.at(-1);
        const grandparent = stack.at(-2);
        if (
          !inItem &&
          info.localName === 'si' &&
          info.namespaceURI === MAIN &&
          parent?.localName === 'sst' &&
          parent.namespaceURI === MAIN &&
          grandparent === undefined
        ) {
          inItem = true;
          pieces = [];
          charCount = 0;
        } else if (
          inItem &&
          info.localName === 'rPh' &&
          info.namespaceURI === MAIN &&
          parent?.localName === 'si' &&
          parent.namespaceURI === MAIN
        ) {
          inPhonetic = true;
        } else if (
          inItem &&
          info.localName === 't' &&
          info.namespaceURI === MAIN &&
          ((parent?.localName === 'si' && parent.namespaceURI === MAIN && stack.length === 2) ||
            (parent?.localName === 'r' &&
              parent.namespaceURI === MAIN &&
              grandparent?.localName === 'si' &&
              grandparent.namespaceURI === MAIN &&
              stack.length === 3))
        ) {
          inText = !inPhonetic;
        }
        stack.push({ localName: info.localName, namespaceURI: info.namespaceURI });
      },
      onText(text) {
        budget.tick();
        if (inItem && inText && stack.at(-1)?.localName === 't' && stack.at(-1)?.namespaceURI === MAIN) {
          if (pieces.length >= 100_000) throw new LimitExceededError('xlsxObjects', MAX_XLSX_OBJECTS);
          if (storedChars + charCount + text.length > MAX_SHARED_STRING_CHARS)
            throw new LimitExceededError('xlsxStringChars', MAX_SHARED_STRING_CHARS);
          staging.reserveObjects();
          pieces.push(text);
          charCount += text.length;
        }
      },
      onClose(_name, info) {
        budget.tick();
        const parent = stack.at(-2);
        const grandparent = stack.at(-3);
        if (
          inText &&
          info.localName === 't' &&
          info.namespaceURI === MAIN &&
          ((parent?.localName === 'si' && parent.namespaceURI === MAIN && stack.length === 3) ||
            (parent?.localName === 'r' &&
              parent.namespaceURI === MAIN &&
              grandparent?.localName === 'si' &&
              grandparent.namespaceURI === MAIN &&
              stack.length === 4))
        ) {
          inText = false;
        } else if (
          inPhonetic &&
          info.localName === 'rPh' &&
          info.namespaceURI === MAIN &&
          parent?.localName === 'si' &&
          parent.namespaceURI === MAIN
        ) {
          inPhonetic = false;
        } else if (
          inItem &&
          info.localName === 'si' &&
          info.namespaceURI === MAIN &&
          parent?.localName === 'sst' &&
          parent.namespaceURI === MAIN &&
          stack.at(-3) === undefined
        ) {
          if (storedEntries >= MAX_SHARED_STRING_ENTRIES)
            throw new LimitExceededError('xlsxObjects', MAX_XLSX_OBJECTS);
          staging.reserveObjects();
          strings.push(pieces.join(''));
          storedEntries += 1;
          storedChars += charCount;
          inItem = false;
          inPhonetic = false;
          pieces = [];
        }
        stack.pop();
      },
    },
    xlsxStagingXmlContext(budget, warnings, path),
  );
  if (!inRoot) malformed = true;
  if (malformed)
    warnings.add({
      code: 'UNREADABLE_PART',
      message: 'The shared strings part could not be read completely.',
      ...(path ? { loc: { path } } : {}),
    });
  return strings;
}
