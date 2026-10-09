import type { Block, ListItem } from '../../src/index.js';

const isTokenChar = (code: number): boolean =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 95 ||
  code === 37 ||
  code === 43 ||
  code === 45 ||
  code === 46 ||
  code === 64;

function isAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isEmail(candidate: string): boolean {
  let at = -1;
  for (let i = 0; i < candidate.length; i++) {
    if (candidate.charCodeAt(i) === 64) {
      if (at >= 0) return false;
      at = i;
    }
  }
  if (at <= 0 || at === candidate.length - 1) return false;
  const local = candidate.slice(0, at);
  const domain = candidate.slice(at + 1);
  if (local.startsWith('.') || local.endsWith('.')) return false;
  let labelStart = 0;
  let lastDot = -1;
  for (let i = 0; i <= domain.length; i++) {
    if (i === domain.length || domain.charCodeAt(i) === 46) {
      if (i === labelStart || domain.charCodeAt(labelStart) === 45 || domain.charCodeAt(i - 1) === 45)
        return false;
      if (i < domain.length) lastDot = i;
      labelStart = i + 1;
    } else {
      const code = domain.charCodeAt(i);
      if (!isAlpha(code) && !(code >= 48 && code <= 57) && code !== 45) return false;
    }
  }
  if (lastDot < 0 || domain.length - lastDot - 1 < 2) return false;
  for (let i = lastDot + 1; i < domain.length; i++) if (!isAlpha(domain.charCodeAt(i))) return false;
  return true;
}

/** Linear scanner for a deliberately conservative email shape plus US SSN-shaped ID numbers. */
export function maskSensitiveText(text: string): string {
  let result = '';
  let cursor = 0;
  let i = 0;
  while (i < text.length) {
    if (!isTokenChar(text.charCodeAt(i))) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < text.length && isTokenChar(text.charCodeAt(end))) end++;
    let candidateEnd = end;
    while (candidateEnd > i && text.charCodeAt(candidateEnd - 1) === 46) candidateEnd--;
    const candidate = text.slice(i, candidateEnd);
    result += text.slice(cursor, i);
    result += isEmail(candidate) ? '[email]' : candidate;
    cursor = candidateEnd;
    i = end;
  }
  result += text.slice(cursor);
  return result.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[id]');
}

function redactList(items: ListItem[]): ListItem[] {
  const root: ListItem[] = [];
  const pending = [{ source: items, target: root }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const item of current.source) {
      const copy: ListItem = {
        text: maskSensitiveText(item.text),
        ...(item.marker === undefined ? {} : { marker: maskSensitiveText(item.marker) }),
      };
      if (item.items !== undefined) {
        copy.items = [];
        pending.push({ source: item.items, target: copy.items });
      }
      current.target.push(copy);
    }
  }
  return root;
}

/** Redact visible text before it leaves extraction; citation locations stay attached. */
export function redactBlock(block: Block): Block {
  const root: Block[] = [];
  const pending = [{ source: [block], target: root }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const source of current.source) {
      let copy: Block;
      switch (source.kind) {
        case 'section':
          copy = {
            ...source,
            blocks: [],
            ...(source.title === undefined ? {} : { title: maskSensitiveText(source.title) }),
          };
          pending.push({ source: source.blocks, target: copy.blocks });
          break;
        case 'table':
          copy = {
            ...source,
            ...(source.caption === undefined ? {} : { caption: maskSensitiveText(source.caption) }),
            rows: source.rows.map((row) =>
              row.map((cell) => ({
                text: maskSensitiveText(cell.text),
                ...(cell.address === undefined ? {} : { address: cell.address }),
                ...(cell.rowSpan === undefined ? {} : { rowSpan: cell.rowSpan }),
                ...(cell.colSpan === undefined ? {} : { colSpan: cell.colSpan }),
                ...(cell.hidden === undefined ? {} : { hidden: cell.hidden }),
              })),
            ),
          };
          break;
        case 'list':
          copy = { ...source, items: redactList(source.items) };
          break;
        case 'image':
          copy = { ...source, ...(source.alt === undefined ? {} : { alt: maskSensitiveText(source.alt) }) };
          break;
        case 'paragraph':
          copy = { kind: 'paragraph', text: maskSensitiveText(source.text), loc: source.loc };
          break;
        case 'heading':
        case 'code':
        case 'header':
        case 'footer':
          copy = { ...source, text: maskSensitiveText(source.text) };
          break;
        case 'note':
          copy = {
            ...source,
            text: maskSensitiveText(source.text),
            ...(source.author === undefined ? {} : { author: maskSensitiveText(source.author) }),
          };
          break;
      }
      current.target.push(copy);
    }
  }
  return root[0]!;
}
