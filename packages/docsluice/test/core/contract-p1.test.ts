import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { chunk } from '../../src/chunk/index.js';
import { extract } from '../../src/core/extract.js';
import type { Cell, DocsluiceDocument, Run, TableBlock } from '../../src/core/model.js';
import * as root from '../../src/index.js';
import { toJSON } from '../../src/render/json.js';
import { toMarkdown } from '../../src/render/markdown.js';

const update =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UPDATE_GOLDEN ===
  '1';
const corpus = new URL('../../../../corpus/', import.meta.url);
const read = (name: string) => new Uint8Array(readFileSync(new URL(name, corpus)));
const encode = (text: string) => new TextEncoder().encode(text);

function runsOf(doc: DocsluiceDocument): Run[][] {
  return doc.blocks.flatMap((block) => (block.kind === 'paragraph' && block.runs ? [block.runs] : []));
}

describe('inline runs (MOD-3)', () => {
  it.each(['html/inline-formatting.html', 'markdown/inline-formatting.md', 'docx/inline-runs.docx'])(
    '%s matches its reviewed runs: true golden',
    async (name) => {
      const doc = await extract(read(name), { filename: name.slice(name.indexOf('/') + 1), runs: true });
      const json = toJSON(doc, { stable: true });
      const golden = new URL(`${name}.runs.expected.json`, corpus);
      if (update) writeFileSync(golden, json);
      else {
        expect(existsSync(golden), `${name} needs a runs golden`).toBe(true);
        expect(json).toBe(readFileSync(golden, 'utf8'));
      }
    },
  );

  it('marks HTML bold, italic, code and links, merging equal neighbours', async () => {
    const doc = await extract(
      encode(
        '<!doctype html><p><b>a</b><strong>b</strong> <em>c</em><code>d</code><a href="/x"><i>e</i></a></p>',
      ),
      { runs: true },
    );
    expect(runsOf(doc)[0]).toEqual([
      { text: 'ab', bold: true },
      { text: ' ' },
      { text: 'c', italic: true },
      { text: 'd', code: true },
      { text: 'e', italic: true, href: '/x' },
    ]);
  });

  it('reads Markdown emphasis by CommonMark flanking rules', async () => {
    const parse = async (markdown: string) =>
      runsOf(await extract(encode(markdown), { filename: 'x.md', runs: true }))[0];
    expect(await parse('a **b** _c_ ***d*** `e`')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'c', italic: true },
      { text: ' ' },
      { text: 'd', bold: true, italic: true },
      { text: ' ' },
      { text: 'e', code: true },
    ]);
    expect(await parse('snake_case_name and 2 * 3')).toEqual([{ text: 'snake_case_name and 2 * 3' }]);
    expect(await parse('**unclosed bold')).toEqual([{ text: 'unclosed bold', bold: true }]);
    expect(await parse('*a**')).toEqual([{ text: 'a', italic: true }, { text: '*' }]);
  });

  it('renders runs as Markdown with white space outside the markers', async () => {
    const doc = await extract(
      encode('<!doctype html><p><b>bold </b>text <i> it</i>. <code> x </code><br>next</p>'),
      { runs: true },
    );
    expect(toMarkdown(doc)).toBe('**bold** text *it*. `x` next');
  });

  it('leaves runs out unless asked for', async () => {
    const doc = await extract(read('markdown/inline-formatting.md'), { filename: 'inline-formatting.md' });
    expect(runsOf(doc)).toEqual([]);
  });
});

describe('child bytes (NST-5, ADR 0006)', () => {
  const archive = zipSync({ 'a.txt': [strToU8('hello'), { mtime: new Date('1980-01-01T00:00:00Z') }] });

  it('keeps raw child bytes only with childBytes, and toJSON omits them unless asked', async () => {
    const plain = await extract(archive);
    expect(plain.children[0]!.bytes).toBeUndefined();
    const withBytes = await extract(archive, { childBytes: true });
    expect(withBytes.children[0]!.bytes).toEqual(strToU8('hello'));
    expect(toJSON(withBytes)).not.toContain('aGVsbG8');
    expect(toJSON(withBytes, { bytes: 'base64' })).toContain('aGVsbG8=');
  });
});

describe('table header rows in chunks (CHK-4)', () => {
  const table = (rows: number, headerRows = 1, caption?: string): DocsluiceDocument => {
    const cells: Cell[][] = [[{ text: 'Name' }, { text: 'Count' }]];
    for (let index = 1; index <= rows; index++)
      cells.push([{ text: `row${index}` }, { text: String(index) }]);
    const block: TableBlock = { kind: 'table', rows: cells, headerRows, loc: {} };
    if (caption !== undefined) block.caption = caption;
    return {
      format: 'csv',
      mimeType: 'text/csv',
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
  };

  it('repeats the header row at the start of every piece of a split table', () => {
    const chunks = [...chunk(table(30), { maxSize: 60, overlap: 0 })];
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0]!.text.startsWith('Name\tCount\nrow1\t1')).toBe(true);
    expect(chunks[0]!.overlap).toBe(0);
    for (const piece of chunks.slice(1)) {
      expect(piece.text.startsWith('Name\tCount\nrow')).toBe(true);
      expect(piece.overlap).toBe('Name\tCount\n'.length);
      expect(piece.text.length).toBeLessThanOrEqual(60);
    }
    // Every data row appears exactly once outside the repeated headers.
    const rows = chunks
      .flatMap((piece) => piece.text.slice(piece.overlap).split('\n'))
      .filter((line) => line.startsWith('row'));
    expect(rows).toHaveLength(30);
  });

  it('repeats the header instead of the overlap, and not for tables without header rows', () => {
    const withOverlap = [...chunk(table(30), { maxSize: 60, overlap: 20 })];
    for (const piece of withOverlap.slice(1)) expect(piece.text.startsWith('Name\tCount\n')).toBe(true);
    const plain = [...chunk(table(30, 0), { maxSize: 60, overlap: 0 })];
    for (const piece of plain.slice(1)) expect(piece.text.startsWith('Name')).toBe(false);
  });

  it('skips a header that would take more than half a chunk, and keeps the caption out of it', () => {
    const big = [...chunk(table(30), { maxSize: 19, overlap: 0 })];
    expect(big.slice(1).some((piece) => piece.text.startsWith('Name'))).toBe(false);
    const captioned = [...chunk(table(30, 1, 'Totals'), { maxSize: 60, overlap: 0 })];
    expect(captioned[0]!.text.startsWith('Totals\nName\tCount')).toBe(true);
    expect(captioned[1]!.text.startsWith('Name\tCount\nrow')).toBe(true);
  });
});

describe('exported building blocks (EXT-6)', () => {
  it('exports openZip, parseXml and sniff from docsluice', () => {
    expect(typeof root.openZip).toBe('function');
    expect(typeof root.parseXml).toBe('function');
    expect(typeof root.sniff).toBe('function');
  });

  it('sniffs formats from the first bytes without opening containers', () => {
    const sniff = root.sniff;
    expect(sniff(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10))).toMatchObject({ format: 'png' });
    expect(sniff(encode('%PDF-1.7\n'))).toMatchObject({ format: 'pdf', mimeType: 'application/pdf' });
    expect(sniff(read('docx/inline-runs.docx'))).toMatchObject({ format: 'zip' });
    expect(
      sniff(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array<number>(504).fill(0))),
    ).toMatchObject({
      format: 'ole',
    });
    expect(sniff(encode('{"a":1}'))).toMatchObject({ format: 'json', encoding: 'utf-8' });
    expect(sniff(encode('a,b\n1,2\n3,4\n'))).toMatchObject({ format: 'csv' });
    expect(sniff(encode('<!doctype html><p>x</p>'))).toMatchObject({ format: 'html' });
    expect(sniff(encode('just words'))).toMatchObject({ format: 'txt', confidence: 0.65 });
    expect(sniff(Uint8Array.of(0, 1, 2, 3, 0, 0, 0, 255))).toMatchObject({
      format: 'unknown',
      confidence: 0,
    });
    expect(sniff(new Uint8Array())).toMatchObject({ format: 'txt' });
  });

  it('looks at the first 64 KiB only', () => {
    const bytes = new Uint8Array(200_000).fill(0x61);
    bytes.set(encode('%PDF'), 100_000);
    expect(root.sniff(bytes).format).toBe('txt');
  });
});
