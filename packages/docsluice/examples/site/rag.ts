import { extract, toMarkdown } from '../../src/index.js';
import type { DocsluiceDocument, Location } from '../../src/index.js';
import { redactBlock } from './redaction.js';

/** A small ingestion boundary: extract with a redaction transform, then hand Markdown and citations to an indexer. */
export async function ingestForSearch(bytes: Uint8Array, filename: string) {
  const document = await extract(bytes, {
    filename,
    metadata: false,
    children: 'extract',
    limits: { inputBytes: 25_000_000, timeMs: 15_000 },
    transform: redactBlock,
  });
  return {
    document,
    markdown: toMarkdown(document),
    citations: collectLocations(document),
  };
}

function collectLocations(document: DocsluiceDocument): Location[] {
  const result: Location[] = [];
  const pending = [...document.blocks].reverse();
  while (pending.length > 0) {
    const block = pending.pop()!;
    result.push({ ...block.loc });
    if (block.kind === 'section') pending.push(...[...block.blocks].reverse());
  }
  return result;
}
