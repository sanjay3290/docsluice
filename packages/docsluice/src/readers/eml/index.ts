import type { Cell } from '../../core/model.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import { decodeMimeText, parseMime, type MimePart } from '../../mime/index.js';
import { emitHtml } from '../../html/index.js';
import { emitPlain, safeAttachmentName } from './shared.js';

function cleanHeader(value: string | undefined): string | undefined {
  return value?.replace(/[\r\n\t ]+/g, ' ').trim() || undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** RFC 5322 section 4.3 obsolete zone names, in minutes east of UTC. */
const ZONES = new Map([
  ['ut', 0],
  ['gmt', 0],
  ['z', 0],
  ['edt', -240],
  ['est', -300],
  ['cdt', -300],
  ['cst', -360],
  ['mdt', -360],
  ['mst', -420],
  ['pdt', -420],
  ['pst', -480],
]);

function digits(token: string | undefined, min: number, max: number): number | undefined {
  if (token === undefined || token.length < min || token.length > max) return undefined;
  let value = 0;
  for (let index = 0; index < token.length; index++) {
    const code = token.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return undefined;
    value = value * 10 + code - 0x30;
  }
  return value;
}

function zoneMinutes(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const named = ZONES.get(token.toLowerCase());
  if (named !== undefined) return named;
  if (token.length !== 5 || (token[0] !== '+' && token[0] !== '-')) return undefined;
  const hours = digits(token.slice(1, 3), 2, 2);
  const minutes = digits(token.slice(3), 2, 2);
  if (hours === undefined || minutes === undefined || minutes > 59) return undefined;
  return (token[0] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

/**
 * Parse an RFC 5322 date-time (with obsolete two-digit years and zone names) into ISO 8601 UTC.
 * Hand-written so the result never depends on the engine's `Date.parse` or the host time zone.
 */
function rfc5322Date(value: string): string | undefined {
  const tokens = value.split(' ').filter((token) => token.length > 0);
  let at = 0;
  if (tokens[0]?.endsWith(',')) at = 1;
  const day = digits(tokens[at], 1, 2);
  const month = MONTHS.indexOf(tokens[at + 1]?.toLowerCase() ?? '');
  let year = digits(tokens[at + 2], 2, 4);
  const time = tokens[at + 3]?.split(':') ?? [];
  const hour = digits(time[0], 2, 2);
  const minute = digits(time[1], 2, 2);
  const second = time.length > 2 ? digits(time[2], 2, 2) : 0;
  const zone = zoneMinutes(tokens[at + 4]);
  if (
    day === undefined ||
    month < 0 ||
    year === undefined ||
    time.length > 3 ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    zone === undefined ||
    (tokens.length > at + 5 && !tokens[at + 5]!.startsWith('(')) ||
    hour > 23 ||
    minute > 59 ||
    second > 60
  )
    return undefined;
  if (tokens[at + 2]!.length === 2) year += year < 50 ? 2000 : 1900;
  else if (tokens[at + 2]!.length === 3) year += 1900;
  const local = Date.UTC(year, month, day, hour, minute, Math.min(second, 59));
  if (new Date(local).getUTCDate() !== day) return undefined;
  return new Date(local - zone * 60_000).toISOString();
}

function topLevelParts(parts: MimePart[], budget: ReadContext['budget']): MimePart[] {
  const selected: MimePart[] = [];
  const stack = [...parts].reverse();
  while (stack.length > 0) {
    budget.tick();
    const part = stack.pop()!;
    if (part.contentType.value === 'multipart/alternative') {
      const leaves: MimePart[] = [];
      const nested = [...part.parts].reverse();
      while (nested.length > 0) {
        budget.tick();
        const child = nested.pop()!;
        if (child.disposition.value === 'attachment' || child.filename) continue;
        if (child.parts.length > 0)
          for (let index = child.parts.length - 1; index >= 0; index--) nested.push(child.parts[index]!);
        else leaves.push(child);
      }
      const plain = leaves.find((leaf) => leaf.contentType.value === 'text/plain');
      const html = leaves.find((leaf) => leaf.contentType.value === 'text/html');
      if (plain) selected.push(plain);
      else if (html) selected.push(html);
      continue;
    }
    if (part.disposition.value === 'attachment' || part.filename) continue;
    if (part.parts.length > 0) {
      for (let index = part.parts.length - 1; index >= 0; index--) stack.push(part.parts[index]!);
    } else if (part.contentType.value === 'text/plain' || part.contentType.value === 'text/html')
      selected.push(part);
  }
  return selected;
}

function allParts(parts: MimePart[], budget: ReadContext['budget']): MimePart[] {
  const result: MimePart[] = [];
  const stack = [...parts].reverse();
  while (stack.length > 0) {
    budget.tick();
    const part = stack.pop()!;
    result.push(part);
    for (let index = part.parts.length - 1; index >= 0; index--) stack.push(part.parts[index]!);
  }
  return result;
}

function emitParts(ctx: ReadContext, parts: MimePart[], cidReferences: ReadonlyMap<string, string>): void {
  for (const part of parts) {
    ctx.budget.tick();
    if (part.contentType.value === 'text/html') {
      // The parser charges raw HTML bytes to totalUncompressedBytes; only emitted text uses outputChars.
      const html = decodeMimeText(part, ctx.budget, part.bytes?.length ?? 0);
      emitHtml(ctx, html, cidReferences);
    } else {
      const remaining = Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars);
      let text = decodeMimeText(part, ctx.budget, remaining + 1);
      if (text.length > remaining) {
        ctx.budget.checkOutputChars(remaining + 1);
        text = text.slice(0, remaining);
      }
      emitPlain(ctx, text);
    }
  }
}

/** Read a MIME email while keeping all attachment expansion on the parent's child pipeline. */
export async function readEml(ctx: ReadContext): Promise<void> {
  ctx.budget.tick();
  const message = parseMime(ctx.bytes, ctx.budget);
  const from = cleanHeader(message.headers.get('from'));
  const to = cleanHeader(message.headers.get('to'));
  const cc = cleanHeader(message.headers.get('cc'));
  const subject = cleanHeader(message.headers.get('subject'));
  const rawDate = cleanHeader(message.headers.get('date'));
  // metadata.created is ISO 8601 only; a date we cannot parse stays as text in the header table.
  const created = rawDate === undefined ? undefined : rfc5322Date(rawDate);
  const date = created ?? rawDate;
  if (subject) ctx.out.setMetadata({ title: subject });
  if (created) ctx.out.setMetadata({ created });
  if (from && ctx.options.metadata) ctx.out.setMetadata({ authors: [from] });
  const rows: Cell[][] = [[{ text: 'Field' }, { text: 'Value' }]];
  if (ctx.options.metadata) {
    if (from) rows.push([{ text: 'From' }, { text: from }]);
    if (to) rows.push([{ text: 'To' }, { text: to }]);
    if (cc) rows.push([{ text: 'Cc' }, { text: cc }]);
  }
  if (date) rows.push([{ text: 'Date' }, { text: date }]);
  if (subject) rows.push([{ text: 'Subject' }, { text: subject }]);
  if (rows.length > 1) ctx.out.table(rows, 1, ctx.path ? { path: ctx.path } : {});

  const flattened = allParts(message.parts, ctx.budget);
  let hasAttachments = false;
  const cidReferences = new Map<string, string>();
  for (const part of flattened) {
    ctx.budget.tick();
    const attached =
      part.disposition.value === 'attachment' ||
      part.filename !== undefined ||
      (part.disposition.value === 'inline' && part.contentId !== undefined) ||
      part.contentType.value === 'message/rfc822';
    if (!attached || !part.bytes) continue;
    hasAttachments = true;
    const name = safeAttachmentName(part.filename, part.contentId, ctx.budget);
    await ctx.extractChild(name, part.bytes, { mimeType: part.contentType.value });
    if (part.disposition.value === 'inline' && part.contentId) {
      cidReferences.set(part.contentId, ctx.path ? `${ctx.path}/${name}` : name);
    }
  }
  if (hasAttachments) ctx.out.setFeature('hasEmbeddedFiles');

  emitParts(ctx, topLevelParts(message.parts, ctx.budget), cidReferences);
}

/** The EML reader: headers as a field/value table, one body choice, attachments as child documents. */
export const emlReader: Reader = { id: 'eml', mimeTypes: ['message/rfc822'], read: readEml };
