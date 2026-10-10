import type { ListItem, Location } from '../../core/model.js';
import type { ReadContext } from '../../core/reader.js';
import type { DocxNoteRef, DocxParagraph } from './body.js';
import { listMarker, NumberingCounters } from './numbering.js';
import type { DocxNumbering } from './numbering.js';
import type { DocxStyle } from './styles.js';

const MAX_LEVEL = 8;

interface Group {
  numId: string;
  ordered: boolean;
  roots: ListItem[];
  /** Open items with their levels; an item's parent is the nearest one at a lower level. */
  stack: Array<{ ilvl: number; item: ListItem }>;
  loc: Location;
  /** Notes referenced by the items, emitted after the list block. */
  notes: DocxNoteRef[];
}

/**
 * Turns numbered paragraphs into `list` blocks (DOC-3). Consecutive list paragraphs form one
 * block; any other paragraph ends it. Counters continue per `numId` across blocks, as Word does.
 */
export class DocxLists {
  readonly #ctx: ReadContext;
  readonly #numbering: DocxNumbering;
  readonly #styles: ReadonlyMap<string, DocxStyle>;
  readonly #counters = new NumberingCounters();
  readonly #onNotes: ((notes: readonly DocxNoteRef[]) => void) | undefined;
  #group: Group | undefined;

  constructor(
    ctx: ReadContext,
    numbering: DocxNumbering,
    styles: ReadonlyMap<string, DocxStyle>,
    onNotes?: (notes: readonly DocxNoteRef[]) => void,
  ) {
    this.#ctx = ctx;
    this.#numbering = numbering;
    this.#styles = styles;
    this.#onNotes = onNotes;
  }

  /** Paragraph handler for `scanDocxBody`: returns true when the paragraph became a list item. */
  accept(paragraph: DocxParagraph): boolean {
    const budget = this.#ctx.budget;
    budget.tick();
    const style = paragraph.styleId === undefined ? undefined : this.#styles.get(paragraph.styleId);
    const numId = paragraph.numId ?? style?.numId;
    // numId 0 explicitly removes numbering inherited from the style.
    const instance = numId === undefined || numId === '0' ? undefined : this.#numbering.get(numId);
    if (numId === undefined || !instance) {
      this.flush();
      return false;
    }
    const ilvl = Math.min(paragraph.ilvl ?? style?.ilvl ?? 0, MAX_LEVEL);
    const counters = this.#counters.next(numId, instance, ilvl, budget);
    // A numbered heading keeps the document structure; its counter still advances.
    if (paragraph.level !== undefined) {
      this.flush();
      return false;
    }
    if (this.#group && this.#group.numId !== numId && ilvl === 0) this.flush();
    if (!this.#group) {
      const group: Group = {
        numId,
        ordered: (instance.levels.get(ilvl)?.numFmt ?? 'decimal') !== 'bullet',
        roots: [],
        stack: [],
        loc: paragraph.loc,
        notes: [],
      };
      this.#group = group;
    }
    const group = this.#group;
    if (paragraph.notes) group.notes.push(...paragraph.notes);
    const item: ListItem = { text: paragraph.text };
    const marker = listMarker(instance.levels, counters, ilvl, budget);
    if (marker.length > 0) item.marker = marker;
    while (group.stack.length > 0 && group.stack.at(-1)!.ilvl >= ilvl) {
      budget.tick();
      group.stack.pop();
    }
    const parent = group.stack.at(-1)?.item;
    if (parent) (parent.items ??= []).push(item);
    else group.roots.push(item);
    group.stack.push({ ilvl, item });
    return true;
  }

  /** Emit the open list block, if any. */
  flush(): void {
    const group = this.#group;
    if (!group) return;
    this.#group = undefined;
    this.#ctx.out.list(group.ordered, group.roots, group.loc);
    if (group.notes.length > 0) this.#onNotes?.(group.notes);
  }
}
