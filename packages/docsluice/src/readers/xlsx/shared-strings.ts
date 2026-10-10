import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import { SHEET_NAMESPACES } from './spreadsheetml.js';

/**
 * Collects the visible text of a string item (`si`, or an inline `is`): its own `t`, or the `t` of
 * each rich-text run `r`. Phonetic runs (`rPh`) are reading aids, not cell text, and are skipped.
 */
export class StringItemText {
  #text = '';
  #textDepth = 0;
  #phoneticDepth = 0;

  open(local: string | undefined): void {
    if (local === 'rPh') this.#phoneticDepth++;
    else if (local === 't' && this.#phoneticDepth === 0) this.#textDepth++;
  }

  close(local: string | undefined): void {
    if (local === 'rPh') this.#phoneticDepth--;
    else if (local === 't' && this.#phoneticDepth === 0) this.#textDepth--;
  }

  append(text: string): void {
    if (this.#textDepth > 0) this.#text += text;
  }

  take(): string {
    const text = this.#text;
    this.#text = '';
    this.#textDepth = 0;
    this.#phoneticDepth = 0;
    return text;
  }
}

export interface XlsxSharedStrings {
  strings: string[];
  /** True when the table was cut by a limit; missing indexes are then not file errors. */
  truncated: boolean;
}

/**
 * Parse `sharedStrings.xml` (ECMA-376 Part 1, 18.4) with bounded SAX events. The scanner charges
 * staged text against `outputChars`; the number of items is capped at the `cells` limit, since a
 * workbook cannot show more distinct strings than it has cells.
 */
export function parseSharedStrings(input: Uint8Array, ctx: XmlContext): XlsxSharedStrings {
  const strings: string[] = [];
  const item = new StringItemText();
  const names: Array<string | undefined> = [];
  const maxItems = ctx.budget.limits.cells;
  let inItem = false;
  let truncated = false;
  let capped = false;
  scanXml(
    input,
    {
      onOpen(_name, _attrs, info) {
        ctx.budget.tick();
        const local =
          info.namespaceURI !== undefined && SHEET_NAMESPACES.has(info.namespaceURI)
            ? info.localName
            : undefined;
        if (local === 'si' && names.length === 1) {
          if (truncated && !capped) {
            capped = true;
            ctx.warnings.add({
              code: 'TRUNCATED',
              message: `The shared-string table has more than ${maxItems} items (the cells limit); later items were skipped.`,
              ...(ctx.path ? { loc: { path: ctx.path } } : {}),
            });
          }
          inItem = !truncated;
          item.take();
        } else if (inItem) {
          item.open(local);
        }
        names.push(local);
      },
      onText(text) {
        if (inItem) item.append(text);
      },
      onClose() {
        ctx.budget.tick();
        const local = names.pop();
        if (local === 'si' && names.length === 1 && inItem) {
          inItem = false;
          strings.push(item.take());
          if (strings.length >= maxItems) truncated = true;
        } else if (inItem) {
          item.close(local);
        }
      },
    },
    ctx,
  );
  if (ctx.budget.truncated) truncated = true;
  return { strings, truncated };
}
