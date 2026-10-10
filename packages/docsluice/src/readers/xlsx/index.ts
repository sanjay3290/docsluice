import type { Location } from '../../core/model.js';
import type { Reader, ReadContext } from '../../core/reader.js';
import {
  OoxmlParts,
  readContentTypes,
  readProperties,
  readRelationships,
  scanFeatures,
} from '../../ooxml/index.js';
import type { OoxmlRelationship } from '../../ooxml/index.js';
import { openZip } from '../../zip/index.js';
import type { XmlContext } from '../../xml/index.js';
import { rangeName, regionRows, sheetRegions } from './layout.js';
import { parseSharedStrings } from './shared-strings.js';
import type { XlsxSharedStrings } from './shared-strings.js';
import { parseWorksheet } from './sheet.js';
import { GENERAL_STYLES, parseStyles } from './styles.js';
import type { XlsxStyles } from './styles.js';
import { parseWorkbook } from './workbook.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Workbook part content types for workbooks, templates and their macro-enabled forms. */
const MAIN_PART_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
  'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  'application/vnd.ms-excel.template.macroEnabled.main+xml',
]);
const REL_BASES = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/',
];

function isRelationship(relationship: { type: string }, kind: string): boolean {
  return REL_BASES.some((base) => relationship.type === `${base}${kind}`);
}

function pathWithPrefix(prefix: string, part: string): string {
  return prefix ? `${prefix}/${part}` : part;
}

function relationshipOfKind(
  relationships: ReadonlyMap<string, OoxmlRelationship>,
  kind: string,
  ctx: XmlContext,
): OoxmlRelationship | undefined {
  for (const relationship of relationships.values()) {
    ctx.budget.tick();
    if (isRelationship(relationship, kind) && !relationship.external && relationship.part)
      return relationship;
  }
  return undefined;
}

async function readWorkbookPart(
  parts: OoxmlParts,
  ctx: XmlContext,
): Promise<{ path: string; bytes: Uint8Array } | undefined> {
  const rootRelationships = await readRelationships(parts, '', ctx);
  const officeDocument = relationshipOfKind(rootRelationships, 'officeDocument', ctx);
  const candidates: string[] = [];
  if (officeDocument?.part) candidates.push(officeDocument.part);
  if (!candidates.includes('xl/workbook.xml')) candidates.push('xl/workbook.xml');
  for (const path of candidates) {
    ctx.budget.tick();
    const bytes = await parts.read(path);
    if (bytes) return { path, bytes };
  }
  return undefined;
}

async function readSharedStrings(
  parts: OoxmlParts,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
  ctx: XmlContext,
  prefix: string,
): Promise<XlsxSharedStrings> {
  const relationship = relationshipOfKind(relationships, 'sharedStrings', ctx);
  const path = relationship?.part ?? 'xl/sharedStrings.xml';
  const bytes = await parts.read(path);
  if (!bytes) return { strings: [], truncated: false };
  return parseSharedStrings(bytes, {
    budget: ctx.budget,
    warnings: ctx.warnings,
    path: pathWithPrefix(prefix, path),
  });
}

async function readStyles(
  parts: OoxmlParts,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
  ctx: XmlContext,
  prefix: string,
): Promise<XlsxStyles> {
  const relationship = relationshipOfKind(relationships, 'styles', ctx);
  const path = relationship?.part ?? 'xl/styles.xml';
  const bytes = await parts.read(path);
  if (!bytes) return GENERAL_STYLES;
  return parseStyles(bytes, {
    budget: ctx.budget,
    warnings: ctx.warnings,
    path: pathWithPrefix(prefix, path),
  });
}

/** Reader for SpreadsheetML `.xlsx` workbooks: every sheet is a `section` of tables (XLS-1). */
export const xlsxReader: Reader = {
  id: 'xlsx',
  mimeTypes: [XLSX_MIME],
  async read(ctx: ReadContext): Promise<void> {
    const archive = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
    const xmlContext: XmlContext = {
      budget: ctx.budget,
      warnings: ctx.warnings,
      ...(ctx.path ? { path: ctx.path } : {}),
    };
    const parts = new OoxmlParts(archive, xmlContext);
    const contentTypes = await readContentTypes(parts, xmlContext);
    const main = await readWorkbookPart(parts, xmlContext);
    if (!main) {
      ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'The workbook part could not be read.' });
      return;
    }
    const mainType = contentTypes.mimeType(main.path);
    if (mainType !== undefined && !MAIN_PART_TYPES.has(mainType)) {
      ctx.warnings.add({
        code: 'FORMAT_MISMATCH',
        message: 'The XLSX workbook part has an unexpected content type.',
      });
    }
    const mainContext: XmlContext = {
      budget: ctx.budget,
      warnings: ctx.warnings,
      path: pathWithPrefix(ctx.path, main.path),
    };
    const relationships = await readRelationships(parts, main.path, mainContext);
    const workbook = parseWorkbook(main.bytes, mainContext);
    // Ancillary XML is staged before sheet output charges the shared output allowance.
    ctx.out.setMetadata(await readProperties(parts, mainContext, ctx.options.metadata));
    const features = await scanFeatures(parts, archive, xmlContext);
    if (features.hasMacros) ctx.out.setFeature('hasMacros');
    if (features.hasExternalLinks) ctx.out.setFeature('hasExternalLinks');
    if (features.hasEmbeddedFiles) ctx.out.setFeature('hasEmbeddedFiles');
    if (features.isEncrypted) ctx.out.setFeature('isEncrypted');
    if (features.hasJavaScript) ctx.out.setFeature('hasJavaScript');
    const sharedStrings = await readSharedStrings(parts, relationships, xmlContext, ctx.path);
    const styles = await readStyles(parts, relationships, xmlContext, ctx.path);

    let badSharedString = false;
    for (let index = 0; index < workbook.sheets.length; index++) {
      ctx.budget.tick();
      const entry = workbook.sheets[index]!;
      const relationship =
        entry.relationshipId === undefined ? undefined : relationships.get(entry.relationshipId);
      const part = relationship && !relationship.external ? relationship.part : undefined;
      const path = part === undefined ? undefined : pathWithPrefix(ctx.path, part);
      const loc: Location = {};
      if (entry.name !== undefined && entry.name.length > 0) loc.sheet = entry.name;
      if (path !== undefined) loc.path = path;
      if (!ctx.out.openSection('sheet', loc, loc.sheet, entry.hidden)) break;
      // Chart sheets and dialog sheets hold no cells; their section stays empty.
      if (relationship && !isRelationship(relationship, 'worksheet')) {
        ctx.out.closeSection();
        continue;
      }
      const bytes = part === undefined ? undefined : await parts.read(part);
      if (!bytes || path === undefined) {
        ctx.warnings.add({ code: 'UNREADABLE_PART', message: `Sheet ${index + 1} could not be read.` });
        ctx.out.closeSection();
        continue;
      }
      const sheet = parseWorksheet(bytes, {
        budget: ctx.budget,
        warnings: ctx.warnings,
        path,
        sharedStrings,
        styles,
        date1904: workbook.date1904,
        formulas: ctx.options.formulas,
        onBadSharedString: () => {
          if (badSharedString) return;
          badSharedString = true;
          ctx.warnings.add({
            code: 'UNREADABLE_PART',
            message: 'A shared-string index is out of range; the cell is empty.',
            loc: { path },
          });
        },
      });
      let gridRows = 0;
      let gridCells = 0;
      let keptRows = 0;
      let keptCells = 0;
      let open = true;
      for (const region of sheetRegions(sheet, ctx.budget)) {
        ctx.budget.tick();
        const height = region.range.bottom - region.range.top + 1;
        gridRows += height;
        gridCells += height * (region.range.right - region.range.left + 1);
        if (!open) continue;
        const table = regionRows(sheet, region, ctx.budget);
        keptRows += table.rows.length;
        keptCells += table.cells;
        if (table.rows.length < height) open = false;
        const tableLoc: Location = {};
        if (loc.sheet !== undefined) tableLoc.sheet = loc.sheet;
        tableLoc.range = rangeName(region.range);
        if (table.rows.length > 0 && !ctx.out.table(table.rows, 0, tableLoc)) open = false;
      }
      if (sheet.missingCachedValues > 0) {
        ctx.warnings.add({
          code: 'UNREADABLE_PART',
          message: `Sheet ${index + 1}: ${sheet.missingCachedValues} formula cells have no cached value and are empty; formulas are never calculated.`,
          loc: { path },
        });
      }
      if (sheet.skippedCells > 0) ctx.budget.addCells(sheet.skippedCells);
      const skippedRows = gridRows - keptRows + sheet.skippedRows;
      const skippedCells = gridCells - keptCells + sheet.skippedCells;
      if (skippedCells > 0) {
        ctx.warnings.add({
          code: 'TRUNCATED',
          message: `Sheet ${index + 1}: kept ${keptRows} rows and ${keptCells} cells; skipped ${skippedRows} rows and ${skippedCells} cells.`,
          loc: { path },
        });
      }
      if (!ctx.out.closeSection()) break;
    }
  },
};
