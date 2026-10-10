import type { Budget } from '../core/budget.js';

/** Split text into lines at LF, CR LF or CR, without the line ends. One linear pass; every line ticks. */
export function splitLines(text: string, budget: Budget): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code !== 0x0a && code !== 0x0d) {
      if ((index & 0xfff) === 0) budget.tick();
      continue;
    }
    budget.tick();
    lines.push(text.slice(start, index));
    if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) index++;
    start = index + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Whether a line holds only spaces and tabs. */
export function isBlank(line: string): boolean {
  for (let index = 0; index < line.length; index++) {
    const code = line.charCodeAt(index);
    if (code !== 0x20 && code !== 0x09) return false;
  }
  return true;
}
