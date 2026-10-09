import type { Budget } from '../../core/budget.js';
import type { Location } from '../../core/model.js';
import type { WarningSink } from '../../core/warnings.js';
import type { XmlElement } from '../../xml/tree.js';
import { builtInNumberFormat } from './numfmt.js';

const SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const MAX_SOURCE_OBJECTS = 100_000;
const MAX_SOURCE_TEXT = 20_000_000;
const MAX_STYLE_RECORDS = 100_000;
const MAX_FORMAT_CODE_LENGTH = 2_048;
const MAX_NUM_FMT_ID = 1_000_000;

interface FormatRecord {
  numFmtId: number;
  applyNumberFormat: boolean | undefined;
  xfId: number | undefined;
}

export interface XlsxStyles {
  /** Number format id for each cell XF, in file order. */
  readonly cellNumFmtIds: readonly number[];
  /** Resolve an `s` cell-style index to a number format code. */
  getStyleFormat(styleIndex: number): string;
}

const EMPTY_STYLES: XlsxStyles = Object.freeze({
  cellNumFmtIds: Object.freeze([0]),
  getStyleFormat(): string {
    return 'General';
  },
});

function warnUnreadable(warnings: WarningSink, loc?: Location): void {
  warnings.add({
    code: 'UNREADABLE_PART',
    message: 'Spreadsheet styles could not be read.',
    ...(loc ? { loc } : {}),
  });
}

function isElement(child: XmlElement | string): child is XmlElement {
  return typeof child !== 'string';
}

function directChildren(parent: XmlElement, localName: string, budget: Budget): XmlElement[] {
  const found: XmlElement[] = [];
  for (const child of parent.children) {
    budget.tick();
    if (isElement(child) && child.localName === localName && child.namespaceURI === SPREADSHEET_NS) {
      found.push(child);
      if (found.length > 1) return found;
    }
  }
  return found;
}

function parseBoundedInteger(value: string | undefined, max: number, budget: Budget): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  let parsed = 0;
  for (let index = 0; index < value.length; index += 1) {
    budget.tick();
    const digit = value.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) return undefined;
    parsed = parsed * 10 + digit;
    if (!Number.isSafeInteger(parsed) || parsed > max) return undefined;
  }
  return parsed;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
}

/**
 * Parse the bounded number-format portion of an XLSX styles part.
 * Missing styles data yields the default General format; malformed styles warn once.
 */
export function parseStyles(
  root: XmlElement | undefined,
  budget: Budget,
  warnings: WarningSink,
  loc?: Location,
): XlsxStyles {
  budget.tick();
  if (!root) return EMPTY_STYLES;
  let warned = false;
  const warnOnce = (): void => {
    if (warned) return;
    warnUnreadable(warnings, loc);
    warned = true;
  };
  const fail = (): XlsxStyles => {
    warnOnce();
    return EMPTY_STYLES;
  };
  if (root.localName !== 'styleSheet' || root.namespaceURI !== SPREADSHEET_NS) return fail();
  if (!withinSourceLimits(root, budget)) return fail();

  const numFmtsElements = directChildren(root, 'numFmts', budget);
  const styleXfElements = directChildren(root, 'cellStyleXfs', budget);
  const cellXfElements = directChildren(root, 'cellXfs', budget);
  if (numFmtsElements.length > 1 || styleXfElements.length > 1 || cellXfElements.length > 1) return fail();
  if (cellXfElements.length !== 1) return fail();

  const customFormats = new Map<number, string>();
  const numFmts = numFmtsElements[0];
  if (numFmts) {
    for (const child of numFmts.children) {
      budget.tick();
      if (!isElement(child) || child.localName !== 'numFmt' || child.namespaceURI !== SPREADSHEET_NS)
        continue;
      const id = parseBoundedInteger(child.attrs.get('numFmtId'), MAX_NUM_FMT_ID, budget);
      const formatCode = child.attrs.get('formatCode');
      if (id === undefined || formatCode === undefined || customFormats.has(id)) return fail();
      if (formatCode.length > MAX_FORMAT_CODE_LENGTH) {
        warnOnce();
        customFormats.set(id, 'General');
      } else {
        customFormats.set(id, formatCode);
      }
    }
  }

  const styleXfs: FormatRecord[] = [];
  const styleXfsElement = styleXfElements[0];
  if (styleXfsElement) {
    for (const child of styleXfsElement.children) {
      budget.tick();
      if (!isElement(child) || child.localName !== 'xf' || child.namespaceURI !== SPREADSHEET_NS) continue;
      if (styleXfs.length >= MAX_STYLE_RECORDS) return fail();
      const record = parseXf(child, budget);
      if (!record) return fail();
      styleXfs.push(record);
    }
  }

  const formatIds: number[] = [];
  const cellXfsElement = cellXfElements[0]!;
  for (const child of cellXfsElement.children) {
    budget.tick();
    if (!isElement(child) || child.localName !== 'xf' || child.namespaceURI !== SPREADSHEET_NS) continue;
    if (formatIds.length >= MAX_STYLE_RECORDS) return fail();
    const record = parseXf(child, budget);
    if (!record) return fail();
    let numFmtId = record.numFmtId;
    if (record.applyNumberFormat === false || child.attrs.get('numFmtId') === undefined) {
      if (record.xfId !== undefined) {
        const base = styleXfs[record.xfId];
        if (!base) return fail();
        numFmtId = base.applyNumberFormat === false ? 0 : base.numFmtId;
      } else if (record.applyNumberFormat === false) {
        numFmtId = 0;
      }
    }
    if (numFmtId >= 164 && !customFormats.has(numFmtId)) return fail();
    formatIds.push(numFmtId);
  }
  if (formatIds.length === 0) return fail();

  const resolvedFormats: string[] = [];
  for (const id of formatIds) {
    budget.tick();
    const custom = customFormats.get(id);
    resolvedFormats.push(custom ?? builtInNumberFormat(id));
  }
  return Object.freeze({
    cellNumFmtIds: Object.freeze(formatIds),
    getStyleFormat(styleIndex: number): string {
      if (!Number.isSafeInteger(styleIndex) || styleIndex < 0 || styleIndex >= resolvedFormats.length)
        return 'General';
      return resolvedFormats[styleIndex] ?? 'General';
    },
  });
}

function parseXf(element: XmlElement, budget: Budget): FormatRecord | undefined {
  const numFmtRaw = element.attrs.get('numFmtId');
  const numFmtId = numFmtRaw === undefined ? 0 : parseBoundedInteger(numFmtRaw, MAX_NUM_FMT_ID, budget);
  const xfIdRaw = element.attrs.get('xfId');
  const xfId =
    xfIdRaw === undefined ? undefined : parseBoundedInteger(xfIdRaw, MAX_STYLE_RECORDS - 1, budget);
  const applyRaw = element.attrs.get('applyNumberFormat');
  const applyNumberFormat = parseBoolean(applyRaw);
  if (numFmtId === undefined || (xfIdRaw !== undefined && xfId === undefined)) return undefined;
  if (applyRaw !== undefined && applyNumberFormat === undefined) return undefined;
  return { numFmtId, applyNumberFormat, xfId };
}

/** Count the already-tokenized source tree before retaining any styles-derived data. */
function withinSourceLimits(root: XmlElement, budget: Budget): boolean {
  const stack: Array<XmlElement | string> = [root];
  let objects = 0;
  let textLength = 0;
  while (stack.length > 0) {
    budget.tick();
    const current = stack.pop();
    if (current === undefined) continue;
    objects += 1;
    if (objects > MAX_SOURCE_OBJECTS) return false;
    if (typeof current === 'string') {
      textLength += current.length;
      if (textLength > MAX_SOURCE_TEXT) return false;
      continue;
    }
    textLength += current.name.length + current.localName.length;
    if (textLength > MAX_SOURCE_TEXT) return false;
    for (const [name, value] of current.attrs) {
      budget.tick();
      objects += 1;
      textLength += name.length + value.length;
      if (objects > MAX_SOURCE_OBJECTS || textLength > MAX_SOURCE_TEXT) return false;
    }
    textLength += current.namespaceURI?.length ?? 0;
    if (textLength > MAX_SOURCE_TEXT) return false;
    for (const child of current.children) {
      budget.tick();
      if (objects + stack.length + 1 > MAX_SOURCE_OBJECTS) return false;
      stack.push(child);
    }
  }
  return true;
}
