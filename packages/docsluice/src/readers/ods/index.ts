import { CorruptFileError, EncryptedError } from '../../core/errors.js';
import type { Cell, Location } from '../../core/model.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import { parseOdfManifest } from '../../odf/manifest.js';
import { parseOdfMetadata } from '../../odf/meta.js';
import {
  ODF_OFFICE_NS,
  odfAttribute,
  odfElements,
  odfText,
  odfWarn,
  type OdfElement,
} from '../../odf/common.js';
import { parseXml, type XmlElement } from '../../xml/index.js';
import { openZip, type ZipArchive, type ZipEntry } from '../../zip/index.js';

const TABLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const MIME = 'application/vnd.oasis.opendocument.spreadsheet';

interface CellData {
  element: XmlElement;
  scope: OdfElement;
  repeat: number;
  covered: boolean;
  hasContent: boolean;
  columnSpan?: number;
  rowSpan?: number;
  rowHidden: boolean;
}

interface HiddenRange {
  start: number;
  end: number;
}

export const reader: Reader = {
  id: 'ods',
  mimeTypes: [MIME],
  async read(ctx: ReadContext): Promise<void> {
    const zip = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
    const index = indexEntries(zip.entries, ctx);
    if (!index) return;

    const manifest = await readOptional(zip, index, 'META-INF/manifest.xml', ctx);
    if (manifest) {
      const parsed = parseOdfManifest(manifest, {
        budget: ctx.budget,
        warnings: ctx.warnings,
        path: partPath(ctx, 'META-INF/manifest.xml'),
      });
      if (parsed.hasEncryptedEntries) {
        ctx.out.setFeature('isEncrypted');
        throw new EncryptedError('password-required');
      }
    }
    const meta = await readOptional(zip, index, 'meta.xml', ctx);
    if (meta) {
      const metadata = parseOdfMetadata(
        meta,
        { budget: ctx.budget, warnings: ctx.warnings, path: partPath(ctx, 'meta.xml') },
        { metadata: ctx.options.metadata },
      );
      ctx.out.setMetadata(metadata);
    }
    const content = await readOptional(zip, index, 'content.xml', ctx);
    if (!content) throw new CorruptFileError();
    const contentPath = partPath(ctx, 'content.xml');
    const root = parseXml(content, { budget: ctx.budget, warnings: ctx.warnings, path: contentPath });
    if (!root) throw new CorruptFileError();
    const elements = odfElements(root, ctx.budget);
    const scopes = new Map<XmlElement, OdfElement>();
    let external = false;
    for (const item of elements) {
      ctx.budget.tick();
      scopes.set(item.element, item);
      const href = odfAttribute(item, XLINK_NS, 'href', ctx.budget);
      if (href !== undefined && isExternalTarget(href, ctx)) external = true;
    }
    if (external) ctx.out.setFeature('hasExternalLinks');
    const hasMacro =
      hasEntryPrefix(index.names, 'Basic/', ctx) || hasEntryPrefix(index.names, 'Scripts/', ctx);
    if (hasMacro) {
      ctx.out.setFeature('hasMacros');
      ctx.warnings.add({ code: 'MACROS_PRESENT', message: 'The document contains macros.' });
    }
    if (
      hasEntryPrefix(index.names, 'ObjectReplacements/', ctx) ||
      hasEntryPrefix(index.names, 'embedding/', ctx)
    )
      ctx.out.setFeature('hasEmbeddedFiles');

    const sheets = findSheets(root, scopes, ctx);
    for (const sheet of sheets) {
      ctx.budget.tick();
      const scope = scopes.get(sheet)!;
      const name = odfAttribute(scope, TABLE_NS, 'name', ctx.budget) ?? '';
      const display = odfAttribute(scope, TABLE_NS, 'display', ctx.budget);
      const hidden = display === 'false';
      if (hidden) warnHidden(ctx);
      const loc: Location = { ...(name ? { sheet: name } : {}), path: contentPath };
      const canReadSheet = ctx.out.openSection('sheet', loc, name || undefined);
      if (canReadSheet) parseSheet(sheet, scopes, name, hidden, ctx);
      ctx.out.closeSection();
    }
  },
};

function indexEntries(
  entries: readonly ZipEntry[],
  ctx: ReadContext,
): { exact: Map<string, ZipEntry | null>; names: string[] } | undefined {
  const exact = new Map<string, ZipEntry | null>();
  const names: string[] = [];
  for (const entry of entries) {
    ctx.budget.tick();
    names.push(entry.name);
    if (exact.has(entry.name)) {
      exact.set(entry.name, null);
      continue;
    }
    exact.set(entry.name, entry);
  }
  return { exact, names };
}

async function readOptional(
  zip: ZipArchive,
  index: { exact: Map<string, ZipEntry | null> },
  name: string,
  ctx: ReadContext,
): Promise<Uint8Array | undefined> {
  ctx.budget.tick();
  const entry = index.exact.get(name);
  if (!entry) {
    if (index.exact.has(name))
      odfWarn(ctx, 'UNREADABLE_PART', 'ODF archive contains an ambiguous part name.');
    return undefined;
  }
  const bytes = await zip.read(entry);
  if (!bytes) odfWarn(ctx, 'UNREADABLE_PART', 'An ODF archive part could not be read.');
  return bytes ?? undefined;
}

function findSheets(root: XmlElement, scopes: Map<XmlElement, OdfElement>, ctx: ReadContext): XmlElement[] {
  const result: XmlElement[] = [];
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    ctx.budget.tick();
    const element = stack.pop()!;
    if (element.namespaceURI === TABLE_NS && element.localName === 'table') {
      result.push(element);
      continue;
    }
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = element.children[index];
      if (child && typeof child !== 'string') stack.push(child);
    }
  }
  return result.filter((sheet) => {
    let parent = scopes.get(sheet)?.parent;
    while (parent) {
      ctx.budget.tick();
      if (parent.namespaceURI === TABLE_NS && parent.localName === 'table') return false;
      parent = scopes.get(parent)?.parent;
    }
    let ancestor = scopes.get(sheet)?.parent;
    while (ancestor) {
      ctx.budget.tick();
      if (ancestor.namespaceURI === ODF_OFFICE_NS && ancestor.localName === 'spreadsheet') return true;
      ancestor = scopes.get(ancestor)?.parent;
    }
    return false;
  });
}

function parseSheet(
  sheet: XmlElement,
  scopes: Map<XmlElement, OdfElement>,
  sheetName: string,
  sheetHidden: boolean,
  ctx: ReadContext,
): void {
  const hiddenColumns = collectHiddenColumns(sheet, scopes, ctx);
  const rowElements = collectRows(sheet, ctx);
  const outputRows: Cell[][] = [];
  let rowNumber = 1;
  ctx.budget.tick();
  let stagedOutputChars = sheetName.normalize('NFC').length;
  let stopped = false;
  for (const row of rowElements) {
    ctx.budget.tick();
    const rowScope = scopes.get(row);
    if (!rowScope) continue;
    const repeat = positiveCount(
      odfAttribute(rowScope, TABLE_NS, 'number-rows-repeated', ctx.budget),
      1,
      ctx,
    );
    if (repeat === undefined || !safeCoordinate(rowNumber, repeat)) {
      odfWarn(ctx, 'UNREADABLE_PART', 'ODS contains an invalid repeated row count.');
      break;
    }
    const hidden = odfAttribute(rowScope, TABLE_NS, 'visibility', ctx.budget) === 'collapse' || sheetHidden;
    if (hidden && !sheetHidden) warnHidden(ctx);
    const cells = rowCells(row, scopes, hidden, ctx);
    let hasContent = false;
    for (const cell of cells) {
      ctx.budget.tick();
      if (!cell.covered && cell.hasContent) hasContent = true;
    }
    if (!hasContent) {
      rowNumber += repeat;
      continue;
    }
    for (let rowRepeat = 0; rowRepeat < repeat; rowRepeat += 1) {
      ctx.budget.tick();
      const output: Cell[] = [];
      let column = 1;
      for (const cell of cells) {
        ctx.budget.tick();
        if (!safeCoordinate(column, cell.repeat)) {
          odfWarn(ctx, 'UNREADABLE_PART', 'ODS contains an invalid repeated column count.');
          stopped = true;
          break;
        }
        if (!cell.covered && cell.hasContent) {
          const cellText = cellDisplayText(cell, ctx);
          ctx.budget.tick();
          const outputTextLength = cellText.normalize('NFC').length;
          for (let copy = 0; copy < cell.repeat; copy += 1) {
            ctx.budget.tick();
            if (!ctx.budget.checkOutputChars(stagedOutputChars + outputTextLength)) {
              stopped = true;
              break;
            }
            if (!ctx.budget.addCells(1)) {
              stopped = true;
              break;
            }
            const address = `${sheetName ? `${sheetName}!` : ''}${columnName(column, ctx)}${rowNumber}`;
            const value = makeCell(
              cell,
              address,
              hidden || isHiddenColumn(hiddenColumns, column, ctx),
              ctx,
              cellText,
            );
            output.push(value);
            stagedOutputChars += outputTextLength;
            // A covered-table-cell for each spanned position advances the remaining columns.
            column += 1;
          }
        } else {
          column += cell.repeat;
        }
      }
      if (output.length > 0) outputRows.push(output);
      if (stopped) break;
      rowNumber += 1;
    }
    if (stopped) break;
    // Any row repeat beyond the first is expanded only when it actually has cells.
    if (repeat > 0) rowNumber += 0;
  }
  ctx.out.table(outputRows, 0, {
    ...(sheetName ? { sheet: sheetName } : {}),
    path: partPath(ctx, 'content.xml'),
  });
}

function partPath(ctx: ReadContext, name: string): string {
  return ctx.path ? `${ctx.path}/${name}` : name;
}

function collectRows(sheet: XmlElement, ctx: ReadContext): XmlElement[] {
  const result: XmlElement[] = [];
  const stack: XmlElement[] = [];
  for (let index = sheet.children.length - 1; index >= 0; index -= 1) {
    const child = sheet.children[index];
    if (child && typeof child !== 'string') stack.push(child);
  }
  while (stack.length > 0) {
    ctx.budget.tick();
    const element = stack.pop()!;
    if (element.namespaceURI === TABLE_NS && element.localName === 'table') continue;
    if (element.namespaceURI === TABLE_NS && element.localName === 'table-row') {
      result.push(element);
      continue;
    }
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = element.children[index];
      if (child && typeof child !== 'string') stack.push(child);
    }
  }
  return result;
}

function rowCells(
  row: XmlElement,
  scopes: Map<XmlElement, OdfElement>,
  rowHidden: boolean,
  ctx: ReadContext,
): CellData[] {
  const cells: CellData[] = [];
  for (const child of row.children) {
    ctx.budget.tick();
    if (typeof child === 'string' || child.namespaceURI !== TABLE_NS) continue;
    if (child.localName !== 'table-cell' && child.localName !== 'covered-table-cell') continue;
    const scope = scopes.get(child);
    if (!scope) continue;
    const repeat = positiveCount(
      odfAttribute(scope, TABLE_NS, 'number-columns-repeated', ctx.budget),
      1,
      ctx,
    );
    const columnSpan = positiveCount(
      odfAttribute(scope, TABLE_NS, 'number-columns-spanned', ctx.budget),
      1,
      ctx,
    );
    const rowSpan = positiveCount(odfAttribute(scope, TABLE_NS, 'number-rows-spanned', ctx.budget), 1, ctx);
    if (repeat === undefined || columnSpan === undefined || rowSpan === undefined) {
      odfWarn(ctx, 'UNREADABLE_PART', 'ODS contains an invalid repeated or merged cell count.');
      continue;
    }
    const covered = child.localName === 'covered-table-cell';
    const hasContent = !covered && hasCellContent(child, scope, ctx);
    cells.push({
      element: child,
      scope,
      repeat,
      covered,
      hasContent,
      ...(columnSpan > 1 ? { columnSpan } : {}),
      ...(rowSpan > 1 ? { rowSpan } : {}),
      rowHidden,
    });
  }
  return cells;
}

function hasCellContent(cell: XmlElement, scope: OdfElement, ctx: ReadContext): boolean {
  const stack: XmlElement[] = [cell];
  while (stack.length > 0) {
    ctx.budget.tick();
    const element = stack.pop()!;
    if (element.namespaceURI === TEXT_NS && element.localName === 'p') return true;
    for (const child of element.children) {
      ctx.budget.tick();
      if (child && typeof child !== 'string') stack.push(child);
    }
  }
  for (const local of ['value', 'string-value', 'date-value', 'time-value', 'boolean-value', 'formula']) {
    ctx.budget.tick();
    const officeAttribute = local !== 'formula';
    if (odfAttribute(scope, officeAttribute ? ODF_OFFICE_NS : TABLE_NS, local, ctx.budget) !== undefined)
      return true;
  }
  return false;
}

function cellDisplayText(data: CellData, ctx: ReadContext): string {
  const displayed = displayedCellText(data.element, ctx);
  return (
    displayed ??
    typedDisplay(odfAttribute(data.scope, ODF_OFFICE_NS, 'value-type', ctx.budget), data.scope, ctx)
  );
}

function makeCell(data: CellData, address: string, hidden: boolean, ctx: ReadContext, text: string): Cell {
  const { scope } = data;
  const valueType = odfAttribute(scope, ODF_OFFICE_NS, 'value-type', ctx.budget);
  const rawValue = odfAttribute(scope, ODF_OFFICE_NS, 'value', ctx.budget);
  const formula = odfAttribute(scope, TABLE_NS, 'formula', ctx.budget);
  const cell: Cell = { text, address };
  if (rawValue !== undefined) {
    const number = numericTypes.has(valueType ?? '') ? parseNumber(rawValue, ctx) : undefined;
    if (number !== undefined) cell.raw = number;
    else if (valueType === 'boolean')
      cell.raw = odfAttribute(scope, ODF_OFFICE_NS, 'boolean-value', ctx.budget) === 'true';
    else cell.raw = rawValue;
  } else if (valueType === 'date') {
    const date = odfAttribute(scope, ODF_OFFICE_NS, 'date-value', ctx.budget);
    if (date !== undefined) cell.raw = date;
  } else if (valueType === 'boolean') {
    const bool = odfAttribute(scope, ODF_OFFICE_NS, 'boolean-value', ctx.budget);
    if (bool !== undefined) cell.raw = bool === 'true';
  } else if (valueType === 'string') {
    const string = odfAttribute(scope, ODF_OFFICE_NS, 'string-value', ctx.budget);
    if (string !== undefined) cell.raw = string;
  }
  if (formula !== undefined && ctx.options.formulas) cell.formula = formula;
  if (data.columnSpan !== undefined) cell.colSpan = data.columnSpan;
  if (data.rowSpan !== undefined) cell.rowSpan = data.rowSpan;
  if (hidden) cell.hidden = true;
  return cell;
}

const numericTypes = new Set(['float', 'currency', 'percentage']);

function parseNumber(raw: string, ctx: ReadContext): number | undefined {
  let hasMantissaDigit = false;
  let hasExponent = false;
  let hasExponentDigit = false;
  let hasDecimal = false;
  for (let cursor = 0; cursor < raw.length; cursor++) {
    ctx.budget.tick();
    const code = raw.charCodeAt(cursor);
    if (code >= 48 && code <= 57) {
      if (hasExponent) hasExponentDigit = true;
      else hasMantissaDigit = true;
      continue;
    }
    if (code === 46 && !hasDecimal && !hasExponent) {
      hasDecimal = true;
      continue;
    }
    if ((code === 69 || code === 101) && !hasExponent && hasMantissaDigit) {
      hasExponent = true;
      continue;
    }
    if (code === 43 || code === 45) {
      if (cursor === 0) continue;
      const previous = raw.charCodeAt(cursor - 1);
      if (previous === 69 || previous === 101) continue;
    }
    return undefined;
  }
  if (!hasMantissaDigit || (hasExponent && !hasExponentDigit)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function typedDisplay(type: string | undefined, scope: OdfElement, ctx: ReadContext): string {
  if (type === 'date') return odfAttribute(scope, ODF_OFFICE_NS, 'date-value', ctx.budget) ?? '';
  if (type === 'time') return odfAttribute(scope, ODF_OFFICE_NS, 'time-value', ctx.budget) ?? '';
  if (type === 'boolean')
    return odfAttribute(scope, ODF_OFFICE_NS, 'boolean-value', ctx.budget) === 'true' ? 'TRUE' : 'FALSE';
  if (type === 'string') return odfAttribute(scope, ODF_OFFICE_NS, 'string-value', ctx.budget) ?? '';
  return odfAttribute(scope, ODF_OFFICE_NS, 'value', ctx.budget) ?? '';
}

function displayedCellText(cell: XmlElement, ctx: ReadContext): string | undefined {
  const paragraphs: string[] = [];
  const stack: XmlElement[] = [cell];
  while (stack.length > 0) {
    ctx.budget.tick();
    const element = stack.pop()!;
    if (element !== cell && element.namespaceURI === TEXT_NS && element.localName === 'p') {
      paragraphs.push(odfText(element, ctx.budget));
      continue;
    }
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = element.children[index];
      if (child && typeof child !== 'string') stack.push(child);
    }
  }
  return paragraphs.length > 0 ? paragraphs.join('\n') : undefined;
}

function collectHiddenColumns(
  sheet: XmlElement,
  scopes: Map<XmlElement, OdfElement>,
  ctx: ReadContext,
): HiddenRange[] {
  const hidden: HiddenRange[] = [];
  let column = 1;
  const stack: XmlElement[] = [];
  for (let index = sheet.children.length - 1; index >= 0; index -= 1) {
    const child = sheet.children[index];
    if (child && typeof child !== 'string') stack.push(child);
  }
  while (stack.length > 0) {
    ctx.budget.tick();
    const element = stack.pop()!;
    if (element.namespaceURI === TABLE_NS && element.localName === 'table') continue;
    if (element.namespaceURI === TABLE_NS && element.localName === 'table-column') {
      const scope = scopes.get(element);
      if (!scope) continue;
      const count = positiveCount(
        odfAttribute(scope, TABLE_NS, 'number-columns-repeated', ctx.budget),
        1,
        ctx,
      );
      if (count === undefined || !safeCoordinate(column, count)) {
        odfWarn(ctx, 'UNREADABLE_PART', 'ODS contains an invalid repeated column count.');
        break;
      }
      if (odfAttribute(scope, TABLE_NS, 'visibility', ctx.budget) === 'collapse')
        hidden.push({ start: column, end: column + count - 1 });
      column += count;
      continue;
    }
    if (element.namespaceURI === TABLE_NS && element.localName.startsWith('table-row')) continue;
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = element.children[index];
      if (child && typeof child !== 'string') stack.push(child);
    }
  }
  if (hidden.length > 0) warnHidden(ctx);
  return hidden;
}

function warnHidden(ctx: ReadContext): void {
  for (const warning of ctx.warnings.warnings) {
    ctx.budget.tick();
    if (warning.code === 'HIDDEN_CONTENT') return;
  }
  odfWarn(ctx, 'HIDDEN_CONTENT', 'Hidden spreadsheet content is present.');
}

function isHiddenColumn(ranges: HiddenRange[], column: number, ctx: ReadContext): boolean {
  for (const range of ranges) {
    ctx.budget.tick();
    if (column >= range.start && column <= range.end) return true;
  }
  return false;
}

function positiveCount(raw: string | undefined, fallback: number, ctx: ReadContext): number | undefined {
  if (raw === undefined) return fallback;
  if (raw.length === 0) return undefined;
  let result = 0;
  for (let index = 0; index < raw.length; index++) {
    ctx.budget.tick();
    const code = raw.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    result = result * 10 + code - 48;
    if (!Number.isSafeInteger(result)) return undefined;
  }
  return result > 0 ? result : undefined;
}

function safeCoordinate(start: number, amount: number): boolean {
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(amount) &&
    amount > 0 &&
    Number.isSafeInteger(start + amount)
  );
}

function columnName(column: number, ctx: ReadContext): string {
  let value = column;
  let result = '';
  while (value > 0) {
    ctx.budget.tick();
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function hasEntryPrefix(names: readonly string[], prefix: string, ctx: ReadContext): boolean {
  for (const name of names) {
    ctx.budget.tick();
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

function isExternalTarget(target: string, ctx: ReadContext): boolean {
  for (let index = 0; index < target.length; index++) {
    ctx.budget.tick();
    const code = target.charCodeAt(index);
    if (code === 58) return true;
    if (code === 47 || code === 92) return code === 47 && target.charCodeAt(index + 1) === 47;
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return false;
}
