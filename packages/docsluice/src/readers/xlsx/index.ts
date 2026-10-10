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
import { parseComments, parsePersons, parseThreadedComments } from './comments.js';
import type { XlsxComment } from './comments.js';
import { emitSheetTables } from './emit.js';
import type { XlsxNamedRange } from './emit.js';
import { columnName, parseCellReference } from './spreadsheetml.js';
import { parseTablePart } from './tables.js';
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

const THREADED_COMMENT_REL = 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment';
const PERSON_REL = 'http://schemas.microsoft.com/office/2017/10/relationships/person';

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

interface SheetExtras {
  tables: XlsxNamedRange[];
  /** Comments with the path of the part they came from: threaded ones, then notes on other cells. */
  comments: Array<XlsxComment & { path: string }>;
}

/** Excel tables and comments of one sheet, from the sheet part's relationships (XLS-9). */
async function readSheetExtras(
  parts: OoxmlParts,
  part: string,
  ctx: XmlContext,
  prefix: string,
  persons: () => Promise<ReadonlyMap<string, string>>,
): Promise<SheetExtras> {
  const extras: SheetExtras = { tables: [], comments: [] };
  const relationships = await readRelationships(parts, part, ctx);
  const notes: Array<{ path: string; comments: XlsxComment[] }> = [];
  const threadedRefs = new Set<string>();
  for (const relationship of relationships.values()) {
    ctx.budget.tick();
    if (relationship.external || !relationship.part) continue;
    const kind = isRelationship(relationship, 'table')
      ? 'table'
      : isRelationship(relationship, 'comments')
        ? 'comments'
        : relationship.type === THREADED_COMMENT_REL
          ? 'threaded'
          : undefined;
    if (!kind) continue;
    const bytes = await parts.read(relationship.part);
    if (!bytes) continue;
    const path = pathWithPrefix(prefix, relationship.part);
    const partContext: XmlContext = { budget: ctx.budget, warnings: ctx.warnings, path };
    if (kind === 'table') {
      const table = parseTablePart(bytes, partContext);
      if (table) extras.tables.push(table);
    } else if (kind === 'comments') {
      notes.push({ path, comments: parseComments(bytes, partContext) });
    } else {
      for (const comment of parseThreadedComments(bytes, partContext, await persons())) {
        ctx.budget.tick();
        threadedRefs.add(comment.ref);
        extras.comments.push({ ...comment, path });
      }
    }
  }
  // Excel also writes each threaded comment as a legacy note for older versions; keep one copy.
  for (const { path, comments } of notes) {
    for (const comment of comments) {
      ctx.budget.tick();
      if (!threadedRefs.has(comment.ref)) extras.comments.push({ ...comment, path });
    }
  }
  return extras;
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

    let personList: Promise<ReadonlyMap<string, string>> | undefined;
    const persons = (): Promise<ReadonlyMap<string, string>> =>
      (personList ??= (async () => {
        for (const relationship of relationships.values()) {
          ctx.budget.tick();
          if (relationship.type !== PERSON_REL || relationship.external || !relationship.part) continue;
          const bytes = await parts.read(relationship.part);
          if (bytes) return parsePersons(bytes, xmlContext);
        }
        return new Map<string, string>();
      })());

    // Defined names grouped by sheet once, so many sheets and many names do not multiply.
    const namesBySheet = new Map<string, XlsxNamedRange[]>();
    for (const name of workbook.definedNames) {
      ctx.budget.tick();
      const list = namesBySheet.get(name.sheet);
      const range = { name: name.name, range: name.range };
      if (list) list.push(range);
      else namesBySheet.set(name.sheet, [range]);
    }

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
      const extras = await readSheetExtras(parts, part!, xmlContext, ctx.path, persons);
      const named = [...extras.tables, ...((entry.name && namesBySheet.get(entry.name)) || [])];
      emitSheetTables(ctx, sheet, index, loc.sheet, path, named);
      for (const comment of extras.comments) {
        ctx.budget.tick();
        const noteLoc: Location = { path: comment.path };
        if (loc.sheet !== undefined) noteLoc.sheet = loc.sheet;
        const cell = parseCellReference(comment.ref);
        if (cell) noteLoc.range = `${columnName(cell.column)}${cell.row}`;
        if (!ctx.out.note('comment', comment.text, noteLoc, comment.author)) break;
      }
      if (!ctx.out.closeSection()) break;
      // Each sheet is one top-level block; a streaming consumer can apply backpressure here (EXT-2).
      await ctx.out.flush();
    }
  },
};
