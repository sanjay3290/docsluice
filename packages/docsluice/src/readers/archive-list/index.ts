import type { ReadContext } from '../../core/reader.js';

/** One entry of an archive that is listed, not extracted (7z, RAR). */
export interface ListedEntry {
  name: string;
  size: number;
  directory: boolean;
}

/** A plain relative path: `\` becomes `/`, drive letters, `.`, `..` and control characters go. */
export function cleanEntryName(input: string, ctx: ReadContext): string {
  let normalized = '';
  for (let index = 0; index < input.length; index++) {
    ctx.budget.tick();
    const code = input.charCodeAt(index);
    normalized += code === 0x5c ? '/' : code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? '�' : input[index]!;
  }
  const code = normalized.charCodeAt(0);
  if (
    normalized.length >= 2 &&
    normalized[1] === ':' &&
    ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
  )
    normalized = normalized.slice(2);
  let cleaned = '';
  let start = 0;
  for (let index = 0; index <= normalized.length; index++) {
    ctx.budget.tick();
    if (index < normalized.length && normalized[index] !== '/') continue;
    const segment = normalized.slice(start, index);
    if (segment && segment !== '.' && segment !== '..') cleaned += cleaned ? `/${segment}` : segment;
    start = index + 1;
  }
  return cleaned || 'entry';
}

/**
 * Add archive entries as children without their contents: files are `listed`, directories
 * `skipped`, in archive order. Every entry counts against `zipEntries`; `children: 'skip'` adds
 * nothing.
 */
export function addListedEntries(ctx: ReadContext, entries: readonly ListedEntry[]): void {
  if (ctx.options.children === 'skip') return;
  for (const entry of entries) {
    ctx.budget.tick();
    if (!ctx.budget.addEntries(1)) return;
    const name = cleanEntryName(entry.name, ctx);
    ctx.out.addChild({
      path: ctx.path ? `${ctx.path}/${name}` : name,
      name,
      status: entry.directory ? 'skipped' : 'listed',
      sizeBytes: entry.size,
    });
  }
}
