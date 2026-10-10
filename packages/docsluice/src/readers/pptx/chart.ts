import type { Cell } from '../../core/model.js';
import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import { A_NS, C_NS, parseSmall } from './presentationml.js';

/** Point indexes above this are ignored: PowerPoint charts hold at most a sheet's worth of rows. */
const MAX_POINT = 999_999;

/** A chart's cached data as a table: one row per category, one column per series (PPT-6). */
export interface ChartTable {
  title?: string;
  rows: Cell[][];
}

interface Series {
  name: string;
  categories: Map<number, string>;
  values: Map<number, string>;
}

type Section = 'name' | 'categories' | 'values';

/** `c:ser` children whose caches this reader keeps. Bubble sizes and error bars are not data rows. */
const SECTIONS: ReadonlyMap<string, Section> = new Map([
  ['c:tx', 'name'],
  ['c:cat', 'categories'],
  ['c:xVal', 'categories'],
  ['c:val', 'values'],
  ['c:yVal', 'values'],
]);
/** Containers of `c:pt` points: reference caches, literals and multi-level category levels. */
const POINT_PARENTS: ReadonlySet<string> = new Set([
  'c:strCache',
  'c:numCache',
  'c:strLit',
  'c:numLit',
  'c:lvl',
]);

/**
 * The cached series data of a DrawingML chart part (`c:chartSpace`, ECMA-376 Part 1, 21.2): the
 * chart title and, for every `c:ser` of every plot, its name, categories and values. Only cached
 * values are read; the workbook a chart links to is never opened. Multi-level categories keep their
 * first level (the labels next to the axis). Rows are the point indexes present in the caches, in
 * order, so a sparse cache with a huge `c:ptCount` costs only the points it holds.
 */
export function parseChart(input: Uint8Array, ctx: XmlContext): ChartTable | undefined {
  const names: Array<string | undefined> = [];
  const series: Series[] = [];
  let current: Series | undefined;
  let section: Section | undefined;
  let sectionDepth = 0;
  let levels = 0;
  let point: number | undefined;
  let titleDepth = 0;
  const titleParts: string[] = [];
  let titleText = '';
  /** Text of the open `c:v` or `a:t`, or undefined when no text is collected. */
  let text: string | undefined;

  scanXml(
    input,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        const local =
          info.namespaceURI === C_NS
            ? `c:${info.localName}`
            : info.namespaceURI === A_NS
              ? `a:${info.localName}`
              : undefined;
        const parent = names.at(-1);
        names.push(local);
        if (local === undefined) return;
        if (local === 'c:title' && parent === 'c:chart' && titleDepth === 0) {
          titleDepth = names.length;
          return;
        }
        if (titleDepth > 0) {
          if (local === 'a:t' || local === 'c:v') text = '';
          return;
        }
        if (local === 'c:ser' && parent?.startsWith('c:') && parent.endsWith('Chart') && !current) {
          current = { name: '', categories: new Map(), values: new Map() };
          return;
        }
        if (!current) return;
        if (section === undefined && parent === 'c:ser') {
          section = SECTIONS.get(local);
          if (section !== undefined) {
            sectionDepth = names.length;
            levels = 0;
          }
          return;
        }
        if (section === undefined) return;
        if (local === 'c:lvl') levels++;
        else if (local === 'c:pt' && parent !== undefined && POINT_PARENTS.has(parent)) {
          point = parseSmall(attrs.get('idx'), MAX_POINT);
        } else if (local === 'c:v') {
          text = '';
        }
      },
      onText(value) {
        if (text !== undefined) text += value;
      },
      onClose() {
        ctx.budget.tick();
        const depth = names.length;
        const local = names.pop();
        if (titleDepth > 0) {
          if ((local === 'a:t' || local === 'c:v') && text !== undefined) {
            titleText += text;
            text = undefined;
          } else if (local === 'a:p' || local === 'c:pt') {
            if (titleText.trim().length > 0) titleParts.push(titleText.trim());
            titleText = '';
          } else if (depth === titleDepth) {
            if (titleText.trim().length > 0) titleParts.push(titleText.trim());
            titleDepth = 0;
          }
          return;
        }
        if (local === 'c:v' && text !== undefined && current && section !== undefined) {
          if (section === 'name') {
            current.name += text;
          } else if (point !== undefined && levels <= 1) {
            const target = section === 'categories' ? current.categories : current.values;
            if (!target.has(point)) target.set(point, text);
          }
          text = undefined;
        } else if (local === 'c:pt') {
          point = undefined;
        } else if (section !== undefined && depth === sectionDepth) {
          section = undefined;
        } else if (local === 'c:ser' && current) {
          series.push(current);
          current = undefined;
        }
      },
    },
    ctx,
  );

  if (series.length === 0) return undefined;
  const indexes = new Set<number>();
  for (const entry of series) {
    for (const index of entry.categories.keys()) {
      ctx.budget.tick();
      indexes.add(index);
    }
    for (const index of entry.values.keys()) {
      ctx.budget.tick();
      indexes.add(index);
    }
  }
  const ordered = [...indexes].sort((a, b) => {
    ctx.budget.tick();
    return a - b;
  });

  const rows: Cell[][] = [];
  const header: Cell[] = [{ text: '' }];
  if (!ctx.budget.addCells(series.length + 1)) return undefined;
  for (let index = 0; index < series.length; index++) {
    ctx.budget.tick();
    const name = series[index]!.name.trim();
    header.push({ text: name.length > 0 ? name : `Series ${index + 1}` });
  }
  rows.push(header);
  for (const index of ordered) {
    ctx.budget.tick();
    if (!ctx.budget.addCells(series.length + 1)) break;
    let category: string | undefined;
    const row: Cell[] = [];
    for (const entry of series) {
      ctx.budget.tick();
      category ??= entry.categories.get(index);
      row.push({ text: entry.values.get(index) ?? '' });
    }
    row.unshift({ text: category ?? String(index + 1) });
    rows.push(row);
  }
  const table: ChartTable = { rows };
  if (titleParts.length > 0) table.title = titleParts.join(' ');
  return table;
}
