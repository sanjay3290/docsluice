import { scanXml } from '../../xml/index.js';
import type { XmlContext } from '../../xml/index.js';
import type { OoxmlParts } from '../../ooxml/parts.js';
import { readRelationships } from '../../ooxml/rels.js';
import type { OoxmlRelationship } from '../../ooxml/rels.js';
import { XlsxTextStaging, xlsxStagingXmlContext } from './strings.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const WORKSHEET_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const SHARED_STRINGS_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings';
const STYLES_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAX_WORKBOOK_SHEETS = 500_000;
const MAX_WORKBOOK_SHEET_NAME_CHARS = 20_000_000;

export interface WorkbookSheet {
  name: string;
  state: 'visible' | 'hidden' | 'very';
  part: string;
}

export interface WorkbookParts {
  workbook: string;
  workbookBytes: Uint8Array;
  /** Source-order sheet descriptors retain localSheetId positions, including unresolved parts. */
  sheetDescriptors: WorkbookSheet[];
  /** Only sheets with valid worksheet relationships are parsed and emitted. */
  sheets: WorkbookSheet[];
  date1904: boolean;
  sharedStrings?: string;
  styles?: string;
}

/** Resolve the workbook and sheet part names through package relationships. */
export async function resolveWorkbookParts(
  parts: OoxmlParts,
  ctx: XmlContext,
  staging = new XlsxTextStaging(ctx.budget),
): Promise<WorkbookParts | undefined> {
  const rootRelationships = await readRelationships(parts, '', ctx);
  const office = findRelationship(rootRelationships, OFFICE_REL, ctx);
  if (!office?.part) {
    warn(ctx, 'The workbook relationship could not be resolved.');
    return undefined;
  }
  const workbookBytes = await parts.read(office.part);
  if (!workbookBytes) {
    warn(ctx, 'The workbook part could not be read.');
    return undefined;
  }
  const relationships = await readRelationships(parts, office.part, ctx);
  const sheets: WorkbookSheet[] = [];
  const sheetDescriptors: WorkbookSheet[] = [];
  let sheetNameChars = 0;
  let warnedSheetIssue = false;
  let validRoot = false;
  let hasSheets = false;
  let date1904 = false;
  let hasWorkbookProperties = false;
  let warnedWorkbookProperties = false;
  let currentSheet:
    { name?: string; relationshipId?: string; sourceState?: string; depth: number } | undefined;
  const stack: Array<{ localName: string; namespaceURI?: string; namespaces: Map<string, string> }> = [];
  scanXml(
    workbookBytes,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        const parent = stack.at(-1);
        let namespaces = parent?.namespaces ?? new Map<string, string>();
        let copiedNamespaces = false;
        for (const [name, value] of attrs) {
          ctx.budget.tick();
          if (name === 'xmlns' || name.startsWith('xmlns:')) {
            if (!copiedNamespaces) {
              namespaces = new Map(namespaces);
              copiedNamespaces = true;
            }
            if (name === 'xmlns') namespaces.set('', value);
            else namespaces.set(name.slice(6), value);
          }
        }
        if (stack.length === 0) {
          validRoot = info.localName === 'workbook' && info.namespaceURI === MAIN;
        }
        if (
          info.namespaceURI === MAIN &&
          info.localName === 'workbookPr' &&
          parent?.localName === 'workbook' &&
          parent.namespaceURI === MAIN &&
          stack.length === 1
        ) {
          if (hasWorkbookProperties) {
            if (!warnedWorkbookProperties) {
              warnedWorkbookProperties = true;
              warn(ctx, 'Workbook date-system properties could not be read.');
            }
          } else {
            hasWorkbookProperties = true;
            const rawDate1904 = attrs.get('date1904');
            if (rawDate1904 === '1' || rawDate1904 === 'true') date1904 = true;
            else if (rawDate1904 === undefined || rawDate1904 === '0' || rawDate1904 === 'false')
              date1904 = false;
            else if (!warnedWorkbookProperties) {
              warnedWorkbookProperties = true;
              warn(ctx, 'Workbook date-system properties could not be read.');
            }
          }
        }
        if (
          info.namespaceURI === MAIN &&
          info.localName === 'sheets' &&
          parent?.localName === 'workbook' &&
          parent.namespaceURI === MAIN &&
          stack.length === 1
        )
          hasSheets = true;
        if (
          info.namespaceURI === MAIN &&
          info.localName === 'sheet' &&
          parent?.localName === 'sheets' &&
          parent.namespaceURI === MAIN &&
          stack.length === 2
        ) {
          let relationshipId: string | undefined;
          for (const [name, value] of attrs) {
            ctx.budget.tick();
            const colon = name.indexOf(':');
            if (
              colon > 0 &&
              name.slice(colon + 1) === 'id' &&
              namespaces.get(name.slice(0, colon)) === OFFICE_REL_NS
            ) {
              relationshipId = value;
              break;
            }
          }
          currentSheet = {
            name: attrs.get('name'),
            relationshipId,
            sourceState: attrs.get('state'),
            depth: stack.length,
          };
        }
        stack.push({ localName: info.localName, namespaceURI: info.namespaceURI, namespaces });
      },
      onClose(_name, info) {
        ctx.budget.tick();
        const parent = stack.at(-2);
        if (
          currentSheet &&
          info.namespaceURI === MAIN &&
          info.localName === 'sheet' &&
          parent?.localName === 'sheets' &&
          parent.namespaceURI === MAIN &&
          currentSheet.depth === stack.length - 1
        ) {
          const relationship = currentSheet.relationshipId
            ? relationships.get(currentSheet.relationshipId)
            : undefined;
          const resolved = Boolean(
            currentSheet.name &&
            relationship &&
            !relationship.external &&
            relationship.part &&
            relationship.type === WORKSHEET_REL,
          );
          if (!resolved) {
            if (!warnedSheetIssue) {
              warnedSheetIssue = true;
              warn(ctx, 'A workbook sheet could not be resolved.');
            }
          }
          if (sheetDescriptors.length >= MAX_WORKBOOK_SHEETS) {
            if (!warnedSheetIssue) {
              warnedSheetIssue = true;
              warn(ctx, 'The workbook sheet list exceeded the bounded reader capacity.');
            }
          } else {
            staging.reserveObjects();
            const nameTooLong =
              currentSheet.name !== undefined &&
              currentSheet.name.length > MAX_WORKBOOK_SHEET_NAME_CHARS - sheetNameChars;
            if (nameTooLong && !warnedSheetIssue) {
              warnedSheetIssue = true;
              warn(ctx, 'The workbook sheet list exceeded the bounded reader capacity.');
            }
            const name = nameTooLong ? '' : (currentSheet.name ?? '');
            if (!nameTooLong) sheetNameChars += name.length;
            if (
              currentSheet.sourceState !== undefined &&
              currentSheet.sourceState !== 'visible' &&
              currentSheet.sourceState !== 'hidden' &&
              currentSheet.sourceState !== 'veryHidden' &&
              !warnedSheetIssue
            ) {
              warnedSheetIssue = true;
              warn(ctx, 'A workbook sheet state could not be read.');
            }
            const state: WorkbookSheet['state'] =
              currentSheet.sourceState === 'veryHidden'
                ? 'very'
                : currentSheet.sourceState === 'hidden'
                  ? 'hidden'
                  : 'visible';
            const descriptor = {
              name,
              state,
              part: resolved && !nameTooLong ? relationship!.part! : '',
            };
            sheetDescriptors.push(descriptor);
            if (resolved && !nameTooLong) sheets.push(descriptor);
          }
          currentSheet = undefined;
        }
        stack.pop();
      },
    },
    xlsxStagingXmlContext(ctx.budget, ctx.warnings, ctx.path),
  );
  if (!validRoot) {
    warn(ctx, 'The workbook part could not be read.');
    return undefined;
  }
  if (!hasSheets) warn(ctx, 'The workbook sheet list could not be read.');
  // Relationship order for sharedStrings is independent of the sheet list.
  const sharedStrings = findRelationship(relationships, SHARED_STRINGS_REL, ctx)?.part;
  const styles = findRelationship(relationships, STYLES_REL, ctx)?.part;
  return {
    workbook: office.part,
    workbookBytes,
    sheetDescriptors,
    sheets,
    date1904,
    ...(sharedStrings ? { sharedStrings } : {}),
    ...(styles ? { styles } : {}),
  };
}

function findRelationship(
  relationships: Map<string, OoxmlRelationship>,
  type: string,
  ctx: XmlContext,
): OoxmlRelationship | undefined {
  for (const relationship of relationships.values()) {
    ctx.budget.tick();
    if (relationship.type === type && !relationship.external) return relationship;
  }
  return undefined;
}

function warn(ctx: XmlContext, message: string): void {
  ctx.warnings.add({ code: 'UNREADABLE_PART', message, ...(ctx.path ? { loc: { path: ctx.path } } : {}) });
}
