import type { Budget } from '../../core/budget.js';
import { LimitExceededError } from '../../core/errors.js';
import type { Cell } from '../../core/model.js';
import type { XmlElement } from '../../xml/tree.js';

const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const MAX_CHART_OBJECTS = 500_000;
const MAX_CHART_CHARS = 20_000_000;
const SUPPORTED_CHARTS = new Set(['barChart', 'lineChart', 'pieChart']);

interface WorkBudget {
  objects: number;
  reservedOutputChars: number;
}

interface CachePoint {
  text: string;
  raw?: number;
}

interface Cache {
  points: Map<number, CachePoint>;
  maxIndex: number;
}

interface Series {
  name: string;
  categories: Cache;
  values: Cache;
}

/**
 * Read cached data from a chart part without evaluating formulas. Only retained table cells and
 * their text are charged to the shared budget; source XML work has independent hard caps.
 */
export function parseChart(
  root: XmlElement,
  budget: Budget,
): Array<{ rows: Cell[][]; headerRows: number; caption?: string }> {
  if (root.namespaceURI !== CHART_NS || root.localName !== 'chartSpace') return [];

  const work: WorkBudget = { objects: 0, reservedOutputChars: 0 };
  preflightSource(root, budget, work);

  const chart = directChild(root, 'chart', budget);
  const plotArea = chart ? directChild(chart, 'plotArea', budget) : undefined;
  if (!plotArea) return [];

  const tables: Array<{ rows: Cell[][]; headerRows: number; caption?: string }> = [];
  for (const chartType of directChildren(plotArea, undefined, budget)) {
    budget.tick();
    if (!SUPPORTED_CHARTS.has(chartType.localName)) continue;
    reserveObjects(work, 1);
    const series: Series[] = [];
    let maxIndex = -1;
    for (const seriesElement of directChildren(chartType, 'ser', budget)) {
      reserveObjects(work, 1);
      const categoriesElement = directChild(seriesElement, 'cat', budget);
      const valuesElement = directChild(seriesElement, 'val', budget);
      const categories = categoriesElement ? parseCache(categoriesElement, budget, work) : emptyCache();
      const values = valuesElement ? parseCache(valuesElement, budget, work) : emptyCache();
      const titleElement = directChild(seriesElement, 'tx', budget);
      const name = titleElement ? parseSeriesName(titleElement, budget) : undefined;
      series.push({ name: name || `Series ${series.length + 1}`, categories, values });
      maxIndex = Math.max(maxIndex, categories.maxIndex, values.maxIndex);
    }
    if (series.length === 0 || maxIndex < 0) continue;
    const table = retainTable(series, maxIndex, budget, work);
    if (table) tables.push(table);
  }
  return tables;
}

/**
 * Bound the complete source tree before retaining chart references, cache maps or output cells.
 * The shared XML parser has already allocated this tree; these independent caps bound subsequent
 * chart staging and retention, including attributes that are not copied into output.
 */
function preflightSource(root: XmlElement, budget: Budget, work: WorkBudget): void {
  const stack: XmlElement[] = [];
  reserveObjects(work, 1);
  stack.push(root);
  let chars = 0;
  while (stack.length > 0) {
    budget.tick();
    const element = stack.pop()!;
    for (const [name, value] of element.attrs) {
      budget.tick();
      reserveObjects(work, 1);
      chars += name.length + value.length;
      if (!Number.isSafeInteger(chars) || chars > MAX_CHART_CHARS)
        throw new LimitExceededError('pptxChartChars', MAX_CHART_CHARS);
    }
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      budget.tick();
      const child = element.children[index]!;
      if (typeof child === 'string') {
        chars += child.length;
        if (!Number.isSafeInteger(chars) || chars > MAX_CHART_CHARS)
          throw new LimitExceededError('pptxChartChars', MAX_CHART_CHARS);
      } else {
        reserveObjects(work, 1);
        stack.push(child);
      }
    }
  }
}

function reserveObjects(work: WorkBudget, amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0 || work.objects + amount > MAX_CHART_OBJECTS)
    throw new LimitExceededError('pptxObjects', MAX_CHART_OBJECTS);
  work.objects += amount;
}

function retainTable(
  series: Series[],
  maxIndex: number,
  budget: Budget,
  work: WorkBudget,
): { rows: Cell[][]; headerRows: number } | undefined {
  reserveObjects(work, 1);
  const rows: Cell[][] = [];
  reserveObjects(work, series.length + 1);
  const columns: string[] = ['Category'];
  for (const item of series) {
    budget.tick();
    columns.push(item.name);
  }
  let headerChars = 0;
  for (const text of columns) {
    budget.tick();
    headerChars += text.length;
  }
  if (!Number.isSafeInteger(headerChars)) throw new LimitExceededError('pptxChartChars', MAX_CHART_CHARS);
  if (!budget.checkOutputChars(work.reservedOutputChars + headerChars)) return undefined;
  if (!chargeCells(columns.length, budget)) return undefined;
  reserveObjects(work, columns.length + 1);
  const header: Cell[] = [];
  for (const text of columns) {
    budget.tick();
    header.push({ text });
  }
  work.reservedOutputChars += headerChars;
  rows.push(header);

  for (let index = 0; index <= maxIndex; index += 1) {
    budget.tick();
    const categoryPoint = categoryAt(series, index, budget);
    let rowTextChars = categoryPoint?.text.length ?? 0;
    for (const item of series) {
      budget.tick();
      rowTextChars += item.values.points.get(index)?.text.length ?? 0;
    }
    if (!Number.isSafeInteger(rowTextChars)) throw new LimitExceededError('pptxChartChars', MAX_CHART_CHARS);
    if (!budget.checkOutputChars(work.reservedOutputChars + rowTextChars)) break;
    if (!chargeCells(columns.length, budget)) break;
    reserveObjects(work, columns.length + 1);
    const row: Cell[] = [toCell(categoryPoint)];
    for (const item of series) {
      budget.tick();
      row.push(toCell(item.values.points.get(index)));
    }
    work.reservedOutputChars += rowTextChars;
    rows.push(row);
  }
  reserveObjects(work, 1);
  return rows.length > 0 ? { rows, headerRows: 1 } : undefined;
}

function chargeCells(amount: number, budget: Budget): boolean {
  const available = Math.max(0, Math.floor(budget.limits.cells - budget.cells));
  if (amount > available) {
    budget.addCells(available + 1);
    return false;
  }
  for (let index = 0; index < amount; index += 1) {
    budget.tick();
    if (!budget.addCells(1)) return false;
  }
  return true;
}

function categoryAt(series: Series[], index: number, budget: Budget): CachePoint | undefined {
  for (const item of series) {
    budget.tick();
    const point = item.categories.points.get(index);
    if (point !== undefined) return point;
  }
  return undefined;
}

function toCell(point: CachePoint | undefined): Cell {
  if (!point) return { text: '' };
  return point.raw === undefined ? { text: point.text } : { text: point.text, raw: point.raw };
}

function emptyCache(): Cache {
  return { points: new Map(), maxIndex: -1 };
}

function directChild(parent: XmlElement, localName: string, budget: Budget): XmlElement | undefined {
  for (const child of parent.children) {
    budget.tick();
    if (typeof child !== 'string' && child.namespaceURI === CHART_NS && child.localName === localName)
      return child;
  }
  return undefined;
}

function* directChildren(
  parent: XmlElement,
  localName: string | undefined,
  budget: Budget,
): Generator<XmlElement> {
  for (const child of parent.children) {
    budget.tick();
    if (
      typeof child !== 'string' &&
      child.namespaceURI === CHART_NS &&
      (localName === undefined || child.localName === localName)
    )
      yield child;
  }
}

function parseCache(parent: XmlElement, budget: Budget, work: WorkBudget): Cache {
  const cache = emptyCache();
  const reference = firstCacheReference(parent, budget);
  if (!reference) return cache;
  const cacheElement =
    directChild(reference, 'strCache', budget) ?? directChild(reference, 'numCache', budget);
  if (!cacheElement) return cache;
  const numeric = cacheElement.localName === 'numCache';
  for (const point of directChildren(cacheElement, 'pt', budget)) {
    const index = pointIndex(point.attrs.get('idx'), budget);
    if (index === undefined || cache.points.has(index)) continue;
    if (index >= MAX_CHART_OBJECTS) throw new LimitExceededError('pptxObjects', MAX_CHART_OBJECTS);
    const valueElement = directChild(point, 'v', budget);
    if (!valueElement) continue;
    reserveObjects(work, 1);
    const text = textContent(valueElement, budget);
    const cachePoint: CachePoint = { text };
    if (numeric) {
      const number = cachedNumber(text, budget);
      if (number !== undefined) cachePoint.raw = number;
    }
    cache.points.set(index, cachePoint);
    cache.maxIndex = Math.max(cache.maxIndex, index);
  }
  return cache;
}

function firstCacheReference(parent: XmlElement, budget: Budget): XmlElement | undefined {
  for (const child of parent.children) {
    budget.tick();
    if (typeof child !== 'string' && child.namespaceURI === CHART_NS) {
      if (child.localName === 'strRef' || child.localName === 'numRef') return child;
      if (child.localName === 'multiLvlStrRef') return undefined;
    }
  }
  return undefined;
}

function parseSeriesName(title: XmlElement, budget: Budget): string | undefined {
  const literal = directChild(title, 'v', budget);
  if (literal) return textContent(literal, budget);
  const reference = firstCacheReference(title, budget);
  if (!reference) return undefined;
  const cache = directChild(reference, 'strCache', budget);
  if (!cache) return undefined;
  for (const point of directChildren(cache, 'pt', budget)) {
    const index = pointIndex(point.attrs.get('idx'), budget);
    if (index !== 0) continue;
    const value = directChild(point, 'v', budget);
    return value ? textContent(value, budget) : undefined;
  }
  return undefined;
}

function pointIndex(raw: string | undefined, budget: Budget): number | undefined {
  if (!raw || raw.length > 16) return undefined;
  let value = 0;
  for (let index = 0; index < raw.length; index += 1) {
    budget.tick();
    const code = raw.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    value = value * 10 + code - 48;
    if (!Number.isSafeInteger(value)) return undefined;
  }
  return value;
}

function cachedNumber(text: string, budget: Budget): number | undefined {
  let index = 0;
  if (text.charCodeAt(index) === 43 || text.charCodeAt(index) === 45) index += 1;
  let digits = 0;
  while (index < text.length && text.charCodeAt(index) >= 48 && text.charCodeAt(index) <= 57) {
    budget.tick();
    index += 1;
    digits += 1;
  }
  if (text.charCodeAt(index) === 46) {
    budget.tick();
    index += 1;
    while (index < text.length && text.charCodeAt(index) >= 48 && text.charCodeAt(index) <= 57) {
      budget.tick();
      index += 1;
      digits += 1;
    }
  }
  if (digits === 0) return undefined;
  const exponent = text.charCodeAt(index);
  if (exponent === 69 || exponent === 101) {
    budget.tick();
    index += 1;
    if (text.charCodeAt(index) === 43 || text.charCodeAt(index) === 45) index += 1;
    const exponentStart = index;
    while (index < text.length && text.charCodeAt(index) >= 48 && text.charCodeAt(index) <= 57) {
      budget.tick();
      index += 1;
    }
    if (index === exponentStart) return undefined;
  }
  if (index !== text.length) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function textContent(element: XmlElement, budget: Budget): string {
  let text = '';
  for (const child of element.children) {
    budget.tick();
    if (typeof child === 'string') text += child;
  }
  return text;
}
