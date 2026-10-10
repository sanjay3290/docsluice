import type { Cell } from '../../core/model.js';
import type { ReadContext } from '../../core/reader.js';
import type { Component, ContentLine } from './content-lines.js';
import { param, unescapeText } from './content-lines.js';

/** Per-property formatting for one calendar or card format. */
export interface FieldRules {
  /** Properties never shown: identifiers, timestamps, binary data. */
  skipped: ReadonlySet<string>;
  /** Personal properties, shown only with `metadata: true`. */
  personal: ReadonlySet<string>;
  /** The display text of one property value. */
  format(line: ContentLine): string;
}

/** A calendar date or date-time (`20250314`, `20250314T090000Z`) as ISO 8601; other text unchanged. */
export function isoDateTime(value: string, timeZone: string | undefined): string {
  const digits = (from: number, to: number) => {
    for (let index = from; index < to; index++) {
      const code = value.charCodeAt(index);
      if (code < 48 || code > 57) return false;
    }
    return true;
  };
  if (value.length === 8 && digits(0, 8))
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (
    (value.length === 15 || (value.length === 16 && value[15] === 'Z')) &&
    digits(0, 8) &&
    value[8] === 'T' &&
    digits(9, 15)
  ) {
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`;
    if (value.length === 16) return `${iso}Z`;
    return timeZone ? `${iso} (${timeZone})` : iso;
  }
  return value;
}

/** `CN="Name"` and a `mailto:` value as `Name <address>`. */
export function person(line: ContentLine): string {
  const value = line.value.toLowerCase().startsWith('mailto:') ? line.value.slice(7) : line.value;
  const name = param(line, 'CN');
  return name && name !== value ? `${name} <${value}>` : value;
}

/**
 * One two-column table (Field, Value) per component, its properties in file order. Personal
 * properties need `metadata: true`; skipped ones never appear. Returns false when output stops.
 */
export function emitComponent(ctx: ReadContext, component: Component, rules: FieldRules): boolean {
  const rows: Cell[][] = [[{ text: 'Field' }, { text: 'Value' }]];
  for (const line of component.lines) {
    ctx.budget.tick();
    if (rules.skipped.has(line.name) || line.name.startsWith('X-')) continue;
    if (rules.personal.has(line.name) && !ctx.options.metadata) continue;
    const text = rules.format(line).trim();
    if (text.length > 0) rows.push([{ text: line.name }, { text }]);
  }
  if (rows.length === 1) return true;
  return ctx.out.table(rows, 1, ctx.path ? { path: ctx.path } : {});
}

export { unescapeText };
