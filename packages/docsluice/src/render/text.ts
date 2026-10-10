import type { Block, DocsluiceDocument, SectionBlock } from '../core/model.js';
import { Budget } from '../core/budget.js';
import { resolveLimits } from '../core/limits.js';
import { layout } from './layout.js';
import type { TextOptions } from './layout.js';

/** Render a document as plain text with blank lines between blocks. */
export function toText(document: DocsluiceDocument, options: TextOptions = {}): string {
  const budget = new Budget(resolveLimits(), { onLimit: 'throw' });
  const chunks: string[] = [];
  for (const event of layout(document, options, budget, true)) {
    budget.tick();
    if (event.type === 'text') chunks.push(event.text);
  }
  return chunks.join('');
}

/** Fill each block's character span using the same layout as the default `toText` output. */
export function assignOffsets(document: DocsluiceDocument, budget?: Budget): void {
  const sectionStarts = new Map<SectionBlock, number>();
  let offset = 0;
  for (const event of layout(document, {}, budget)) {
    budget?.tick();
    switch (event.type) {
      case 'start-section':
        sectionStarts.set(event.block, offset);
        break;
      case 'end-section':
        event.block.loc.offset = [sectionStarts.get(event.block) ?? offset, offset];
        break;
      case 'text': {
        if (event.block) {
          const start = offset;
          offset += event.text.length;
          event.block.loc.offset = [start, offset];
        } else {
          offset += event.text.length;
        }
        break;
      }
    }
  }
}

/** The two characters `toText` puts between top-level blocks. */
const BLOCK_SEPARATOR = 2;

/**
 * Assign offsets to top-level blocks one at a time, in output order, with the same result as
 * `assignOffsets` on the finished document. Used to stream blocks with final offsets (EXT-2).
 */
export function createOffsetTracker(budget?: Budget): (block: Block) => void {
  let next = 0;
  let first = true;
  return (block) => {
    const start = first ? next : next + BLOCK_SEPARATOR;
    first = false;
    const single: DocsluiceDocument = {
      format: 'unknown',
      mimeType: 'application/octet-stream',
      metadata: {},
      features: {
        hasMacros: false,
        hasExternalLinks: false,
        hasEmbeddedFiles: false,
        isEncrypted: false,
        hasJavaScript: false,
      },
      blocks: [block],
      children: [],
      warnings: [],
      stats: { bytesRead: 0, durationMs: 0, truncated: false, needsOcr: false },
    };
    assignOffsets(single, budget);
    // Shift the block and everything nested in sections by where it starts in the document.
    const pending: Block[] = [block];
    while (pending.length > 0) {
      budget?.tick();
      const current = pending.pop()!;
      const offset = current.loc.offset;
      if (offset) current.loc.offset = [offset[0] + start, offset[1] + start];
      if (current.kind === 'section') pending.push(...current.blocks);
    }
    next = block.loc.offset ? block.loc.offset[1] : start;
  };
}
