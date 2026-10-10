import type { Budget } from '../../core/budget.js';
import type { ReadContext } from '../../core/reader.js';
import { isBlank, splitLines } from '../text-lines.js';

export interface Cue {
  /** `hh:mm:ss.mmm-hh:mm:ss.mmm`. */
  range: string;
  text: string;
}

/**
 * A cue time (`hh:mm:ss,mmm`, `hh:mm:ss.mmm` or `mm:ss.mmm`) as `hh:mm:ss.mmm`, or undefined.
 * Hand-written: no regular expressions over file data.
 */
function cueTime(value: string): string | undefined {
  const parts = value.trim().replace(',', '.').split(':');
  if (parts.length < 2 || parts.length > 3) return undefined;
  if (parts.length === 2) parts.unshift('00');
  const [hours, minutes, rest] = parts as [string, string, string];
  const [seconds, millis] = rest.split('.');
  const ok = (text: string | undefined, min: number, max: number) => {
    if (text === undefined || text.length < min || text.length > max) return false;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 48 || code > 57) return false;
    }
    return true;
  };
  if (!ok(hours, 1, 3) || !ok(minutes, 2, 2) || !ok(seconds, 2, 2) || !ok(millis, 3, 3)) return undefined;
  return `${hours.padStart(2, '0')}:${minutes}:${seconds}.${millis!}`;
}

/** `start --> end [settings]` as a range, or undefined for any other line. */
export function cueRange(line: string): string | undefined {
  const arrow = line.indexOf('-->');
  if (arrow < 0) return undefined;
  const start = cueTime(line.slice(0, arrow));
  const after = line.slice(arrow + 3).trim();
  const space = after.search(/[ \t]/);
  const end = cueTime(space < 0 ? after : after.slice(0, space));
  return start && end ? `${start}-${end}` : undefined;
}

const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['nbsp', ' '],
  ['lrm', '‎'],
  ['rlm', '‏'],
]);

/**
 * Cue text without markup tags (`<i>`, `<v Speaker>`, `<00:01.000>`) and with entities decoded.
 * Linear: a `<` with no `>` after it stops tag removal, and an entity name is at most six letters.
 */
export function plainCueText(text: string, budget: Budget): string {
  let out = '';
  let noTagEnd = false;
  for (let index = 0; index < text.length; index++) {
    if ((index & 0xfff) === 0) budget.tick();
    const char = text[index]!;
    if (char === '<' && !noTagEnd) {
      const close = text.indexOf('>', index);
      if (close > index) {
        index = close;
        continue;
      }
      noTagEnd = true;
    } else if (char === '&') {
      let semicolon = -1;
      for (let at = index + 1; at < text.length && at <= index + 7; at++) {
        if (text[at] === ';') {
          semicolon = at;
          break;
        }
      }
      const entity = semicolon > 0 ? ENTITIES.get(text.slice(index + 1, semicolon)) : undefined;
      if (entity !== undefined) {
        out += entity;
        index = semicolon;
        continue;
      }
    }
    out += char;
  }
  return out;
}

/**
 * Cues of a SubRip or WebVTT file: blocks separated by blank lines whose first or second line is a
 * timing line. Blocks without one (the WebVTT header, NOTE, STYLE and REGION blocks, SubRip junk)
 * are skipped and counted.
 */
export function parseCues(text: string, budget: Budget): { cues: Cue[]; skipped: number } {
  const cues: Cue[] = [];
  let skipped = 0;
  let block: string[] = [];
  const finish = (): void => {
    if (block.length === 0) return;
    const timing = cueRange(block[0]!) !== undefined ? 0 : cueRange(block[1] ?? '') !== undefined ? 1 : -1;
    if (timing < 0) skipped++;
    else {
      const range = cueRange(block[timing]!)!;
      const lines = block.slice(timing + 1).map((line) => plainCueText(line, budget).trim());
      cues.push({ range, text: lines.filter((line) => line.length > 0).join('\n') });
    }
    block = [];
  };
  for (const line of splitLines(text, budget)) {
    budget.tick();
    if (isBlank(line)) finish();
    else block.push(line);
  }
  finish();
  return { cues, skipped };
}

/** One paragraph per cue with text; the cue's time range is its `loc.path`. */
export async function emitCues(ctx: ReadContext, cues: readonly Cue[]): Promise<void> {
  let emitted = 0;
  for (const cue of cues) {
    ctx.budget.tick();
    if (cue.text.length === 0) continue;
    const path = ctx.path ? `${ctx.path}/${cue.range}` : cue.range;
    if (!ctx.out.paragraph(cue.text, { path })) return;
    // A streaming consumer can apply backpressure between cues (EXT-2).
    if (++emitted % 256 === 0) await ctx.out.flush();
  }
}
