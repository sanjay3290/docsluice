import type { ReadContext, Reader } from '../../core/reader.js';
import { decodeReaderText, emitParagraph } from '../text-family.js';

function makeReader(id: 'srt' | 'vtt', mimeType: string, separator: ',' | '.'): Reader {
  return {
    id,
    mimeTypes: [mimeType],
    // The common reader contract is async so readers can extract nested documents.
    // eslint-disable-next-line @typescript-eslint/require-await
    async read(ctx: ReadContext): Promise<void> {
      const text = decodeReaderText(ctx);
      if (text === undefined) return;
      const lines = text.split(/\r\n|\n|\r/);
      let index = 0;
      while (index < lines.length) {
        ctx.budget.tick();
        const line = lines[index]!.trim();
        if (line === '' || line === 'WEBVTT') {
          index++;
          continue;
        }
        if (line === 'NOTE' || line.startsWith('NOTE ') || line === 'STYLE' || line === 'REGION') {
          index++;
          while (index < lines.length && lines[index]!.trim() !== '') {
            ctx.budget.tick();
            index++;
          }
          continue;
        }
        const range = timeRange(line, separator);
        if (range === undefined) {
          index++;
          continue;
        }
        if (!ctx.budget.addCells(1)) return;
        const cue: string[] = [];
        index++;
        while (index < lines.length && lines[index]!.trim() !== '') {
          ctx.budget.tick();
          cue.push(lines[index]!);
          index++;
        }
        if (cue.length > 0 && !emitParagraph(ctx, cue.join('\n'), range)) return;
      }
    },
  };
}

function timeRange(line: string, separator: ',' | '.'): string | undefined {
  const arrow = line.indexOf('-->');
  if (arrow < 0) return undefined;
  const left = line.slice(0, arrow).trim();
  const right =
    line
      .slice(arrow + 3)
      .trim()
      .split(/[ \t]/, 1)[0] ?? '';
  if (validTime(left, separator) && validTime(right, separator)) return `${left} --> ${right}`;
  return undefined;
}

function validTime(value: string, separator: ',' | '.'): boolean {
  const parts = value.split(':');
  if (parts.length !== 2 && parts.length !== 3) return false;
  const last = parts.at(-1)!;
  const dot = last.indexOf(separator);
  if (dot < 0 || last.length - dot - 1 !== 3) return false;
  const seconds = last.slice(0, dot);
  if (seconds.length !== 2 || !digits(seconds) || !digits(last.slice(dot + 1))) return false;
  if (parts.length === 3 && (parts[0]!.length !== 2 || !digits(parts[0]!))) return false;
  const minutes = parts.at(-2)!;
  return minutes.length === 2 && digits(minutes);
}

function digits(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) < 48 || value.charCodeAt(index) > 57) return false;
  return true;
}

export const srt = makeReader('srt', 'application/x-subrip', ',');
export const vtt = makeReader('vtt', 'text/vtt', '.');
const readers = { srt, vtt };
export default readers;
