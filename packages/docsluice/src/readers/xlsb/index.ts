import type { Location } from '../../core/model.js';
import type { Reader, ReadContext } from '../../core/reader.js';
import { OoxmlParts, readProperties, readRelationships, scanFeatures } from '../../ooxml/index.js';
import type { OoxmlRelationship } from '../../ooxml/index.js';
import { openZip } from '../../zip/index.js';
import type { XmlContext } from '../../xml/index.js';
import { emitSheetNotes, emitSheetTables } from '../xlsx/emit.js';
import type { SheetNote, XlsxNamedRange } from '../xlsx/emit.js';
import { GENERAL_STYLES } from '../xlsx/styles.js';
import {
  parseXlsbComments,
  parseXlsbSheet,
  parseXlsbStrings,
  parseXlsbStyles,
  parseXlsbTable,
  parseXlsbWorkbook,
} from './parse.js';
import type { XlsbStrings } from './parse.js';

const XLSB_MIME = 'application/vnd.ms-excel.sheet.binary.macroEnabled.12';
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

/** Reader for binary `.xlsb` workbooks ([MS-XLSB]): the same sheet sections and tables as XLSX. */
export const xlsbReader: Reader = {
  id: 'xlsb',
  mimeTypes: [XLSB_MIME],
  async read(ctx: ReadContext): Promise<void> {
    const archive = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
    const xmlContext: XmlContext = {
      budget: ctx.budget,
      warnings: ctx.warnings,
      ...(ctx.path ? { path: ctx.path } : {}),
    };
    const parts = new OoxmlParts(archive, xmlContext);
    const rootRelationships = await readRelationships(parts, '', xmlContext);
    const mainPath =
      relationshipOfKind(rootRelationships, 'officeDocument', xmlContext)?.part ?? 'xl/workbook.bin';
    const mainBytes = await parts.read(mainPath);
    if (!mainBytes) {
      ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'The workbook part could not be read.' });
      return;
    }
    const mainContext: XmlContext = {
      budget: ctx.budget,
      warnings: ctx.warnings,
      path: pathWithPrefix(ctx.path, mainPath),
    };
    const relationships = await readRelationships(parts, mainPath, mainContext);
    const workbook = parseXlsbWorkbook(mainBytes, ctx.budget);
    // Ancillary parts are staged before sheet output charges the shared output allowance.
    ctx.out.setMetadata(await readProperties(parts, mainContext, ctx.options.metadata));
    const features = await scanFeatures(parts, archive, xmlContext);
    if (features.hasMacros) ctx.out.setFeature('hasMacros');
    if (features.hasExternalLinks) ctx.out.setFeature('hasExternalLinks');
    if (features.hasEmbeddedFiles) ctx.out.setFeature('hasEmbeddedFiles');
    if (features.isEncrypted) ctx.out.setFeature('isEncrypted');
    const stringsPart = relationshipOfKind(relationships, 'sharedStrings', xmlContext)?.part;
    const stringsBytes = stringsPart === undefined ? undefined : await parts.read(stringsPart);
    const strings: XlsbStrings = stringsBytes
      ? parseXlsbStrings(stringsBytes, ctx.budget)
      : { strings: [], damaged: false };
    const stylesPart = relationshipOfKind(relationships, 'styles', xmlContext)?.part;
    const stylesBytes = stylesPart === undefined ? undefined : await parts.read(stylesPart);
    const styles = stylesBytes ? parseXlsbStyles(stylesBytes, ctx.budget) : GENERAL_STYLES;

    let damaged = workbook.damaged || strings.damaged;
    let badSharedString = false;
    for (let index = 0; index < workbook.sheets.length; index++) {
      ctx.budget.tick();
      const entry = workbook.sheets[index]!;
      const relationship =
        entry.relationshipId === null ? undefined : relationships.get(entry.relationshipId);
      const part = relationship && !relationship.external ? relationship.part : undefined;
      const path = part === undefined ? undefined : pathWithPrefix(ctx.path, part);
      const loc: Location = {};
      if (entry.name.length > 0) loc.sheet = entry.name;
      if (path !== undefined) loc.path = path;
      const hidden = entry.state === 2 ? 'very' : entry.state === 1;
      if (!ctx.out.openSection('sheet', loc, loc.sheet, hidden || undefined)) break;
      // Chart, dialog and macro sheets, and module sheets without a part, hold no cells.
      if (!relationship || !isRelationship(relationship, 'worksheet')) {
        if (!ctx.out.closeSection()) break;
        continue;
      }
      const bytes = part === undefined ? undefined : await parts.read(part);
      if (!bytes || path === undefined) {
        ctx.warnings.add({ code: 'UNREADABLE_PART', message: `Sheet ${index + 1} could not be read.` });
        if (!ctx.out.closeSection()) break;
        continue;
      }
      const result = parseXlsbSheet(bytes, {
        budget: ctx.budget,
        strings,
        styles,
        date1904: workbook.date1904,
      });
      if (result.damaged) damaged = true;
      if (result.badSharedString) badSharedString = true;
      // Table parts and comments hang off the sheet part's relationships (XLS-9).
      const named: XlsxNamedRange[] = [];
      const notes: SheetNote[] = [];
      const sheetRelationships = await readRelationships(parts, part!, mainContext);
      for (const extra of sheetRelationships.values()) {
        ctx.budget.tick();
        if (extra.external || !extra.part) continue;
        const kind = isRelationship(extra, 'table')
          ? 'table'
          : isRelationship(extra, 'comments')
            ? 'comments'
            : undefined;
        if (!kind) continue;
        const extraBytes = await parts.read(extra.part);
        if (!extraBytes) continue;
        if (kind === 'table') {
          const table = parseXlsbTable(extraBytes, ctx.budget);
          if (table) named.push(table);
        } else {
          for (const note of parseXlsbComments(extraBytes, ctx.budget)) notes.push(note);
        }
      }
      for (const name of workbook.names) {
        ctx.budget.tick();
        if (name.sheet === index) named.push({ name: name.name, range: name.range });
      }
      emitSheetTables(ctx, result.sheet, index, loc.sheet, path, named);
      emitSheetNotes(ctx, notes, loc.sheet, path);
      if (!ctx.out.closeSection()) break;
      // Each sheet is one top-level block; a streaming consumer can apply backpressure here (EXT-2).
      await ctx.out.flush();
    }
    if (badSharedString)
      ctx.warnings.add({
        code: 'UNREADABLE_PART',
        message: 'A shared-string index is out of range; the cell is empty.',
      });
    if (damaged)
      ctx.warnings.add({
        code: 'UNREADABLE_PART',
        message: 'Some workbook records are damaged; the data read before them is kept.',
      });
  },
};
