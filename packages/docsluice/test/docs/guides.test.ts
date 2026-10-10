import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Runs every fenced `ts` block of the guides against corpus files (issue #43). Samples import
// `docsluice` and `docsluice/node`; those imports are pointed at the sources, and the sample file
// names at corpus files, so the guide stays correct without a build.
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const source = fileURLToPath(new URL('../../src/', import.meta.url));
const GUIDES = ['docs/guides/migration.md'];
const FILES = new Map([
  ['report.xlsx', 'corpus/xlsx/cell-types.xlsx'],
  ['letter.docx', 'corpus/docx/hyperlinks-image.docx'],
  ['deck.pptx', 'corpus/pptx/reading-order.pptx'],
  ['uploads.zip', 'corpus/zip/bundle.zip'],
  ['report.pdf', 'corpus/pdf/labels-outline-links.pdf'],
]);
const directory = mkdtempSync(join(tmpdir(), 'docsluice-guides-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function samples(markdown: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split('\n');
  let current: string[] | undefined;
  for (const line of lines) {
    if (current === undefined && line.trim() === '```ts') current = [];
    else if (current !== undefined && line.trim() === '```') {
      blocks.push(current.join('\n'));
      current = undefined;
    } else if (current !== undefined) current.push(line);
  }
  return blocks;
}

function prepare(sample: string): string {
  let code = sample
    .replaceAll("from 'docsluice/node'", `from ${JSON.stringify(join(source, 'node/index.ts'))}`)
    .replaceAll("from 'docsluice'", `from ${JSON.stringify(join(source, 'index.ts'))}`);
  for (const [name, path] of FILES)
    code = code.replaceAll(`'${name}'`, JSON.stringify(join(repository, path)));
  return `${code}\nexport {};\n`;
}

describe.each(GUIDES)('%s', (guide) => {
  const blocks = samples(readFileSync(join(repository, guide), 'utf8'));

  it('has runnable samples', () => {
    expect(blocks.length).toBeGreaterThan(5);
  });

  it.each(blocks.map((block, index) => [index + 1, block] as const))(
    'sample %i runs',
    async (index, block) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const file = join(directory, `${guide.replaceAll('/', '-')}-${index}.ts`);
      writeFileSync(file, prepare(block));
      await import(/* @vite-ignore */ file);
      expect(fetch).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    },
  );
});
