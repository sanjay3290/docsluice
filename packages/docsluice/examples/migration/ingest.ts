// Repository example imports its source entry. Installed applications import from 'docsluice'.
import { extract, toMarkdown } from '../../src/index.js';
import type { Block, ListItem, Location } from '../../src/index.js';

function mask(text: string): string {
  return text
    .replace(/[\w.@+-]+/g, (token) => {
      let end = token.length;
      while (end > 0 && token[end - 1] === '.') end--;
      const candidate = token.slice(0, end);
      const at = candidate.indexOf('@');
      const dot = candidate.lastIndexOf('.');
      if (
        at > 0 &&
        candidate.lastIndexOf('@') === at &&
        dot > at + 1 &&
        /^[\w.+-]+$/.test(candidate.slice(0, at)) &&
        /^[\w.-]+$/.test(candidate.slice(at + 1, dot)) &&
        /^[a-z]{2,}$/i.test(candidate.slice(dot + 1))
      )
        return `[email]${token.slice(end)}`;
      return token;
    })
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[id]');
}

function redactItems(items: ListItem[]): ListItem[] {
  const result: ListItem[] = [];
  const pending = [{ source: items, target: result }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const item of current.source) {
      const copy = { ...item, text: mask(item.text) };
      if (copy.marker !== undefined) copy.marker = mask(copy.marker);
      if (item.items) {
        copy.items = [];
        pending.push({ source: item.items, target: copy.items });
      }
      current.target.push(copy);
    }
  }
  return result;
}

/** Example policy for emails and US-style ID numbers in content, preserving citation locations. */
export function redactBlock(block: Block): Block {
  const result: Block[] = [];
  const pending = [{ source: [block], target: result }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const source of current.source) {
      let copy: Block;
      if (source.kind === 'section') {
        copy = {
          ...source,
          blocks: [],
          ...(source.title === undefined ? {} : { title: mask(source.title) }),
        };
        pending.push({ source: source.blocks, target: copy.blocks });
      } else if (source.kind === 'table') {
        copy = {
          ...source,
          ...(source.caption === undefined ? {} : { caption: mask(source.caption) }),
          rows: source.rows.map((row) =>
            row.map((cell) => ({
              ...(cell.address === undefined ? {} : { address: cell.address }),
              ...(cell.rowSpan === undefined ? {} : { rowSpan: cell.rowSpan }),
              ...(cell.colSpan === undefined ? {} : { colSpan: cell.colSpan }),
              ...(cell.hidden === undefined ? {} : { hidden: cell.hidden }),
              text: mask(cell.text),
            })),
          ),
        };
      } else if (source.kind === 'list') copy = { ...source, items: redactItems(source.items) };
      else if (source.kind === 'image')
        copy = { ...source, ...(source.alt === undefined ? {} : { alt: mask(source.alt) }) };
      else {
        copy =
          source.kind === 'paragraph'
            ? { kind: 'paragraph', text: mask(source.text), loc: source.loc }
            : { ...source, text: mask(source.text) };
        if (source.kind === 'note' && source.author && copy.kind === 'note')
          copy.author = mask(source.author);
      }
      current.target.push(copy);
    }
  }
  return result[0]!;
}

/** One ingestion path for each registered format; extraction errors propagate to the caller. */
export async function ingestForModel(bytes: Uint8Array, filename: string) {
  const document = await extract(bytes, {
    filename,
    metadata: false,
    children: 'extract',
    limits: { inputBytes: 25_000_000, timeMs: 15_000 },
    transform: redactBlock,
  });
  const citations: Location[] = [];
  const pending = [...document.blocks].reverse();
  while (pending.length > 0) {
    const block = pending.pop()!;
    citations.push({ ...block.loc });
    if (block.kind === 'section') pending.push(...[...block.blocks].reverse());
  }
  return { document, markdown: toMarkdown(document), citations };
}
