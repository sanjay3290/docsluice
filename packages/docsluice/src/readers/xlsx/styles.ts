import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import { builtInNumberFormat } from './numfmt.js';
import { parseIndex, SHEET_NAMESPACES } from './spreadsheetml.js';

/** Excel allows about 64,000 cell formats; more entries than this are ignored. */
const MAX_CELL_FORMATS = 65_536;
const MAX_FORMAT_ID = 0xffff;

/** Number format codes for the `s` style indexes of cells (ECMA-376 Part 1, 18.8). */
export interface XlsxStyles {
  /** The format code for a cell's `s` attribute; `undefined` means General. */
  formatOf(styleIndex: number): string | undefined;
}

export const GENERAL_STYLES: XlsxStyles = { formatOf: () => undefined };

/**
 * Parse `styles.xml`: custom `numFmts/numFmt` codes by id, and the `numFmtId` of each
 * `cellXfs/xf` in order. Ids are kept in `Map`s; built-in ids 0–49 come from the standard table.
 */
export function parseStyles(input: Uint8Array, ctx: XmlContext): XlsxStyles {
  const custom = new Map<number, string>();
  const cellFormats: number[] = [];
  const names: Array<string | undefined> = [];
  scanXml(
    input,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        const local =
          info.namespaceURI !== undefined && SHEET_NAMESPACES.has(info.namespaceURI)
            ? info.localName
            : undefined;
        const parent = names.at(-1);
        names.push(local);
        if (names.length !== 3) return;
        if (local === 'numFmt' && parent === 'numFmts') {
          const id = parseIndex(attrs.get('numFmtId'), MAX_FORMAT_ID);
          const code = attrs.get('formatCode');
          if (id !== undefined && code !== undefined && !custom.has(id)) custom.set(id, code);
        } else if (local === 'xf' && parent === 'cellXfs' && cellFormats.length < MAX_CELL_FORMATS) {
          cellFormats.push(parseIndex(attrs.get('numFmtId'), MAX_FORMAT_ID) ?? 0);
        }
      },
      onClose() {
        ctx.budget.tick();
        names.pop();
      },
    },
    ctx,
  );
  return {
    formatOf(styleIndex: number): string | undefined {
      const id = cellFormats[styleIndex];
      if (id === undefined || id === 0) return undefined;
      const code = custom.get(id) ?? builtInNumberFormat(id);
      return code.length === 0 || code.toLowerCase() === 'general' ? undefined : code;
    },
  };
}
