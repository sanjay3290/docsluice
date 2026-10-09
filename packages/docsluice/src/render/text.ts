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

/** Assign final-document offsets to one streamed root block without revisiting earlier blocks. */
export function assignBlockOffsets(
  block: Block,
  startOffset: number,
  hasPreviousBlock: boolean,
  budget?: Budget,
): number {
  const document: DocsluiceDocument = {
    format: 'txt',
    mimeType: 'text/plain',
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
  const sectionStarts = new Map<SectionBlock, number>();
  let offset = startOffset + (hasPreviousBlock ? 2 : 0);
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
        if (event.block) event.block.loc.offset = [offset, offset + event.text.length];
        offset += event.text.length;
        break;
      }
    }
  }
  return offset;
}
