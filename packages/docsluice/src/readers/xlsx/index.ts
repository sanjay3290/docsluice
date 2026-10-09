import type { Reader, ReadContext } from '../../core/reader.js';
import type { Location } from '../../core/model.js';
import { OoxmlParts } from '../../ooxml/parts.js';
import { readProperties } from '../../ooxml/props.js';
import { scanFeatures } from '../../ooxml/features.js';
import { openZip } from '../../zip/index.js';
import type { XmlContext } from '../../xml/index.js';
import { parseWorkbookDefinedNames, parseXlsxSheetFeatureBytes, readXlsxPeople } from './features.js';
import type { PreparedXlsxNote, PreparedXlsxTable } from './feature-integration.js';
import { integrateXlsxSheetFeatures } from './feature-integration.js';
import { parseWorksheetCells } from './cells.js';
import { parseStyles, parseStylesXml } from './styles.js';
import type { ParsedSheetCells } from './cells.js';
import { readSharedStrings, XlsxTextStaging } from './strings.js';
import { resolveWorkbookParts } from './sheets.js';
import type { WorkbookSheet } from './sheets.js';

export type ParsedXlsxSheet = WorkbookSheet &
  Omit<ParsedSheetCells, 'tables'> & {
    notes: PreparedXlsxNote[];
    tables: PreparedXlsxTable[];
  };

/** Internal parse result, including sheet state for emitted section metadata. */
export interface ParsedXlsxWorkbook {
  workbookPart: string;
  sheets: ParsedXlsxSheet[];
}

export const xlsxReader: Reader = {
  id: 'xlsx',
  mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  async read(ctx): Promise<void> {
    const parsed = await parseXlsx(ctx);
    emitWorkbook(parsed, ctx);
  },
};

/** Parse an OOXML spreadsheet package into bounded sparse sheet data. */
export async function parseXlsx(ctx: ReadContext): Promise<ParsedXlsxWorkbook> {
  const archive = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
  const xmlContext: XmlContext = {
    budget: ctx.budget,
    warnings: ctx.warnings,
    ...(ctx.path ? { path: ctx.path } : {}),
  };
  const parts = new OoxmlParts(archive, xmlContext);
  const staging = new XlsxTextStaging(ctx.budget);
  const resolved = await resolveWorkbookParts(parts, xmlContext, staging);
  if (!resolved) return { workbookPart: '', sheets: [] };

  const definedNames = parseWorkbookDefinedNames(
    resolved.workbookBytes,
    resolved.sheetDescriptors,
    xmlContext,
    staging,
  );
  const people = await readXlsxPeople(parts, resolved.workbook, xmlContext, staging, ctx.options.metadata);

  const features = await scanFeatures(parts, archive, xmlContext);
  for (const [name, enabled] of Object.entries(features)) {
    ctx.budget.tick();
    if (enabled)
      ctx.out.setFeature(
        name as 'hasMacros' | 'hasExternalLinks' | 'hasEmbeddedFiles' | 'isEncrypted' | 'hasJavaScript',
      );
  }
  ctx.out.setMetadata(await readProperties(parts, xmlContext, ctx.options.metadata));

  const stylesPart = resolved.styles ? await parts.read(resolved.styles) : undefined;
  const styles = stylesPart
    ? parseStylesXml(stylesPart, ctx.budget, ctx.warnings, { path: partLocation(ctx.path, resolved.styles!) })
    : parseStyles(
        undefined,
        ctx.budget,
        ctx.warnings,
        resolved.styles ? { path: partLocation(ctx.path, resolved.styles) } : undefined,
      );
  const sharedStringsPart = resolved.sharedStrings ? await parts.read(resolved.sharedStrings) : undefined;
  const sharedStrings = sharedStringsPart
    ? readSharedStrings(
        sharedStringsPart,
        ctx.budget,
        ctx.warnings,
        partLocation(ctx.path, resolved.sharedStrings!),
        staging,
      )
    : [];
  const sheets: ParsedXlsxSheet[] = [];
  for (const sheet of resolved.sheets) {
    ctx.budget.tick();
    const bytes = await parts.read(sheet.part);
    if (!bytes) continue;
    if (!staging.reserveOutputChars(sheet.name.length)) {
      ctx.warnings.add({
        code: 'TRUNCATED',
        message: 'A worksheet title could not fit within the output character limit.',
        loc: { sheet: sheet.name, path: partLocation(ctx.path, sheet.part) },
      });
      continue;
    }
    const parsed = parseWorksheetCells(
      bytes,
      sharedStrings,
      ctx.budget,
      ctx.warnings,
      partLocation(ctx.path, sheet.part),
      staging,
      styles,
      resolved.date1904,
      ctx.options.formulas,
    );
    const sheetFeatures = await parseXlsxSheetFeatureBytes(
      bytes,
      sheet,
      parts,
      people,
      xmlContext,
      staging,
      ctx.options.metadata,
    );
    const integration = integrateXlsxSheetFeatures(
      parsed,
      sheet,
      sheetFeatures,
      definedNames,
      ctx.budget,
      staging,
      'auto',
      ctx.options.metadata,
    );
    sheets.push({ ...sheet, ...parsed, tables: integration.tables, notes: integration.notes });
  }
  return { workbookPart: resolved.workbook, sheets };
}

function emitWorkbook(parsed: ParsedXlsxWorkbook, ctx: ReadContext): void {
  for (const sheet of parsed.sheets) {
    ctx.budget.tick();
    const loc: Location = { sheet: sheet.name, path: partLocation(ctx.path, sheet.part) };
    if (sheet.state !== 'visible') {
      ctx.warnings.add({
        code: 'HIDDEN_CONTENT',
        message: 'The workbook contains a hidden sheet.',
        loc,
      });
    }
    const opened =
      sheet.state === 'visible'
        ? ctx.out.openSection('sheet', loc, sheet.name)
        : ctx.out.openSection('sheet', loc, sheet.name, {
            hidden: sheet.state === 'very' ? 'very' : true,
          });
    let stopped = false;
    try {
      if (opened) {
        for (const table of sheet.tables) {
          ctx.budget.tick();
          const tableLoc: Location = { ...loc, range: table.range };
          if (!ctx.out.table(table.rows, table.headerRows, tableLoc, table.caption)) {
            stopped = true;
            break;
          }
        }
        if (!stopped) {
          for (const note of sheet.notes) {
            ctx.budget.tick();
            if (!ctx.out.note('comment', note.text, note.loc, note.author)) {
              stopped = true;
              break;
            }
          }
        }
      }
    } finally {
      ctx.out.closeSection();
    }
    if (sheet.skippedCells > 0 || sheet.skippedRows > 0) {
      ctx.warnings.add({
        code: 'TRUNCATED',
        message: `Sheet kept ${sheet.keptRows} rows/${sheet.keptCells} cells and skipped ${sheet.skippedRows} rows/${sheet.skippedCells} cells.`,
        loc,
      });
    }
    if (stopped || !opened) break;
  }
}

function partLocation(prefix: string, part: string): string {
  return prefix ? `${prefix}/${part}` : part;
}

export { parseCellAddress, columnLetters, formatRange } from './addresses.js';
