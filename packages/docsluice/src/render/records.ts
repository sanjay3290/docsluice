import type { TableBlock } from '../core/model.js';
import { Budget } from '../core/budget.js';
import { resolveLimits } from '../core/limits.js';
import { createNullProtoRecord } from '../core/safe.js';

/**
 * A table's rows as records keyed by its header row (REN-5): one record per row after the
 * `headerRows` header rows, with every column as a key and the cell's `text` as the value.
 *
 * Keys come from the last header row. An empty header cell takes the name of a merged header cell
 * that spans it, else `column1`, `column2`, … by position; a table with no header rows has only
 * positional keys. Repeated names get a suffix: `name`, `name_2`, `name_3`. Records have a `null`
 * prototype (SEC-6), so a header such as `__proto__` is an ordinary key.
 */
export function toRecords(table: TableBlock): Array<Record<string, string>> {
  const budget = new Budget(resolveLimits(), { onLimit: 'throw' });
  const headerCount = Math.max(0, Math.min(table.headerRows, table.rows.length));
  const header = headerCount > 0 ? table.rows[headerCount - 1]! : [];
  let width = 0;
  for (const row of table.rows) {
    budget.tick();
    width = Math.max(width, row.length);
  }
  const keys: string[] = [];
  const taken = new Set<string>();
  const next = new Map<string, number>();
  let spanName = '';
  let spanLeft = 0;
  for (let column = 0; column < width; column++) {
    budget.tick();
    const cell = header[column];
    let base = cell?.text.trim() ?? '';
    if (base.length > 0) {
      spanName = base;
      spanLeft = (cell?.colSpan ?? 1) - 1;
    } else if (spanLeft > 0) {
      base = spanName;
      spanLeft--;
    }
    if (base.length === 0) base = `column${column + 1}`;
    let key = base;
    let suffix = next.get(base) ?? 2;
    while (taken.has(key)) {
      budget.tick();
      key = `${base}_${suffix++}`;
    }
    next.set(base, suffix);
    taken.add(key);
    keys.push(key);
  }
  const records: Array<Record<string, string>> = [];
  for (let index = headerCount; index < table.rows.length; index++) {
    budget.tick();
    const row = table.rows[index]!;
    const record = createNullProtoRecord<Record<string, string>>();
    for (let column = 0; column < width; column++) {
      budget.tick();
      record[keys[column]!] = row[column]?.text ?? '';
    }
    records.push(record);
  }
  return records;
}
