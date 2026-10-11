import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extract } from '../../src/core/extract.js';
import type { Block, DocsluiceDocument } from '../../src/core/model.js';
import { pdfReader } from '../../src/readers/pdf/index.js';
import { pageRanges, parsePdfDate } from '../../src/readers/pdf/text.js';

type Section = Extract<Block, { kind: 'section' }>;
const corpus = new URL('../../../../corpus/pdf/', import.meta.url);
const hostile = new URL('../../../../hostile/pdf/', import.meta.url);
const read = (base: URL, name: string) => new Uint8Array(readFileSync(new URL(name, base)));
const pages = (doc: DocsluiceDocument) =>
  doc.blocks.filter((block): block is Section => block.kind === 'section');

/** A plain PDF with `count` pages of `lines` Helvetica lines each (ISO 32000-1, 7.5). */
function textPdf(count: number, lines: number): Uint8Array {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const kids: string[] = [];
  for (let page = 0; page < count; page++) {
    const pageObject = objects.length + 1;
    kids.push(`${pageObject} 0 R`);
    const content = `BT /F1 11 Tf 72 760 Td 14 TL ${Array.from({ length: lines }, (_, line) => `(Page ${page + 1} line ${line + 1}: tide readings were logged at the station.) Tj T*`).join(' ')} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObject + 1} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${count} >>`;
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('PDF reader', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is registered for PDF and reads one section per page', async () => {
    expect(pdfReader.id).toBe('pdf');
    const doc = await extract(read(corpus, 'deck-slide-order.pdf'));
    expect(doc.format).toBe('pdf');
    expect(pages(doc).map((section) => section.loc.page)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(doc.metadata.pageCount).toBe(12);
  });

  it('reads page labels, outline headings on their pages, links and metadata (PDF-1, PDF-6)', async () => {
    const doc = await extract(read(corpus, 'labels-outline-links.pdf'), { runs: true });
    expect(pages(doc).map((section) => section.loc.pageLabel)).toEqual(['i', 'ii', 'A-1', 'A-2', 'A-3']);
    expect(
      pages(doc).map((section) =>
        section.blocks.filter((block) => block.kind === 'heading').map((block) => [block.level, block.text]),
      ),
    ).toEqual([[], [], [[1, 'Methods']], [[2, 'Results section']], [[1, 'Notes']]]);
    const linked = pages(doc)[2]!.blocks.find((block) => block.kind === 'paragraph');
    expect(linked).toMatchObject({
      runs: expect.arrayContaining([
        { text: 'Read the protocol online for details.', href: 'https://example.invalid/protocol' },
      ]) as unknown,
    });
    expect(JSON.stringify(linked)).not.toContain('appendix.pdf');
    expect(doc.features.hasExternalLinks).toBe(true);
    expect(doc.metadata).toEqual({
      title: 'Estuary Survey',
      authors: ['Synthetic Author'],
      created: '2026-04-01T09:30:00+02:00',
      modified: '2026-04-02T00:00:00Z',
      pageCount: 5,
      language: 'en-GB',
    });
    const anonymous = await extract(read(corpus, 'labels-outline-links.pdf'), { metadata: false });
    expect(anonymous.metadata.authors).toBeUndefined();
  });

  it('flags a scanned page with needsOcr and a NEEDS_OCR warning with its page number (PDF-4)', async () => {
    const doc = await extract(read(corpus, 'scanned-image-only.pdf'));
    expect(doc.stats.needsOcr).toBe(true);
    expect(pages(doc)[0]!.needsOcr).toBe(true);
    expect(doc.warnings).toEqual([{ code: 'NEEDS_OCR', message: 'Pages without a text layer need OCR: 1.' }]);
    const text = await extract(read(corpus, 'lists-tables.pdf'));
    expect(text.stats.needsOcr).toBe(false);
    expect(pages(text)[0]!.needsOcr).toBeUndefined();
  });

  it('throws EncryptedError without the password and opens with it', async () => {
    await expect(extract(read(corpus, 'encrypted-document.pdf'))).rejects.toMatchObject({
      code: 'ENCRYPTED',
      reason: 'password-required',
    });
    await expect(
      extract(read(corpus, 'encrypted-document.pdf'), { password: 'wrong' }),
    ).rejects.toMatchObject({
      code: 'ENCRYPTED',
      reason: 'wrong-password',
    });
    const doc = await extract(read(corpus, 'encrypted-document.pdf'), { password: 'docsluice-fixture-only' });
    expect(pages(doc).length).toBeGreaterThan(0);
  });

  it('turns bytes that are not a readable PDF into CorruptFileError', async () => {
    await expect(
      extract(new TextEncoder().encode('%PDF-1.7\nnot really a pdf'), { format: 'pdf' }),
    ).rejects.toMatchObject({
      code: 'CORRUPT_FILE',
    });
  });

  it('never runs or fetches anything, and reports JavaScript and remote actions (PDF-10)', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('no network')));
    vi.stubGlobal('fetch', fetch);
    const realFunction = globalThis.Function;
    let generated = 0;
    globalThis.Function = new Proxy(realFunction, {
      construct(target, args: string[]) {
        generated++;
        return Reflect.construct(target, args);
      },
    });
    try {
      const script = await extract(read(hostile, 'openaction-javascript.pdf'));
      expect(script.features.hasJavaScript).toBe(true);
      const remote = await extract(read(hostile, 'launch-and-remote.pdf'), { runs: true });
      expect(remote.features.hasExternalLinks).toBe(true);
      expect(JSON.stringify(remote.blocks)).not.toContain('calc.exe');
    } finally {
      globalThis.Function = realFunction;
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(generated).toBe(0);
  });

  it('stops at the pdfPages limit with TRUNCATED', async () => {
    const doc = await extract(read(hostile, 'pages-100000-shared.pdf'), { limits: { pdfPages: 10 } });
    expect(pages(doc)).toHaveLength(10);
    expect(doc.stats.truncated).toBe(true);
    expect(doc.metadata.pageCount).toBe(100_000);
  });

  it('reads a Node Buffer and leaves the caller bytes intact', async () => {
    const buffer = readFileSync(new URL('fonts-300.pdf', hostile));
    const before = Uint8Array.from(buffer);
    const doc = await extract(buffer, { limits: { pdfFonts: 3 } });
    expect(pages(doc)[0]!.blocks).toMatchObject([{ kind: 'paragraph', text: 'AAA' }]);
    expect(Uint8Array.from(buffer)).toEqual(before);
  });

  it('caps CMap ranges so a 1 KB ToUnicode bomb stays small (#262)', async () => {
    const expected: [string, string][] = [
      ['cmap-range-16m.pdf', 'A'],
      ['cmap-two-ranges-16m.pdf', 'A'],
      ['cmap-shared-four-fonts.pdf', 'AAAA'],
      // The first 256 ranges fit the cap and map code 0x41 to U+0041 + 0x41; pdf.js drops the rest.
      ['cmap-ranges-over-cap.pdf', '\u0082'],
      ['cmap-high-code.pdf', 'A'],
    ];
    for (const [file, text] of expected) {
      const started = performance.now();
      const doc = await extract(read(hostile, file));
      // Before the cap: 1.9-3.2 GB and 7-17 s. The process tests bound the heap.
      expect(performance.now() - started, file).toBeLessThan(2000);
      // A dropped range does not stop the document: the page and its text are still read.
      expect(pages(doc), file).toHaveLength(1);
      expect(pages(doc)[0]!.blocks, file).toMatchObject([{ kind: 'paragraph', text }]);
      expect(doc.warnings, file).toEqual([]);
    }
  });

  it('stops loading fonts at the pdfFonts limit and keeps the text read so far', async () => {
    const doc = await extract(read(hostile, 'fonts-300.pdf'));
    expect(doc.stats.truncated).toBe(true);
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['TRUNCATED']);
    expect(doc.warnings[0]!.message).toContain('pdfFonts');
    // Text in a refused font is lost: with 50 fonts allowed, 50 of the 300 letters remain.
    const limited = await extract(read(hostile, 'fonts-300.pdf'), { limits: { pdfFonts: 50 } });
    expect(pages(limited)[0]!.blocks).toMatchObject([{ kind: 'paragraph', text: 'A'.repeat(50) }]);
  });

  it('throws LimitExceededError for pdfFonts in throw mode', async () => {
    await expect(extract(read(hostile, 'fonts-300.pdf'), { onLimit: 'throw' })).rejects.toMatchObject({
      name: 'LimitExceededError',
      limit: 'pdfFonts',
    });
  });

  it('counts fonts across the whole extraction and stops the next page', async () => {
    const doc = await extract(read(hostile, 'cmap-shared-four-fonts.pdf'), { limits: { pdfFonts: 2 } });
    expect(doc.stats.truncated).toBe(true);
    expect(doc.warnings[0]!.message).toContain('"pdfFonts" is 2');
    const empty = await extract(textPdf(3, 1), { limits: { pdfFonts: 0 } });
    expect(pages(empty)).toHaveLength(1);
    expect(empty.stats.truncated).toBe(true);
  });

  it('reads a 100-page text PDF within the PERF budget', async () => {
    const bytes = textPdf(100, 40);
    const started = performance.now();
    const doc = await extract(bytes);
    const elapsed = performance.now() - started;
    expect(pages(doc)).toHaveLength(100);
    expect(pages(doc)[99]!.blocks[0]).toMatchObject({
      kind: 'paragraph',
      text: expect.stringContaining('Page 100 line 40') as unknown,
    });
    // Target 3 s (PERF-1); about 0.3-0.5 s measured. The bound leaves room for loaded CI runners.
    expect(elapsed).toBeLessThan(6000);
  }, 20_000);
});

describe('PDF helpers', () => {
  it.each([
    ["D:20260401093000+02'00'", '2026-04-01T09:30:00+02:00'],
    ["D:20260401093000-05'30", '2026-04-01T09:30:00-05:30'],
    ['D:20260402Z', '2026-04-02T00:00:00Z'],
    ['D:2026', '2026-01-01T00:00:00'],
    ['20261231235959', '2026-12-31T23:59:59'],
    ['D:20261301', undefined],
    ['not a date', undefined],
  ])('parses %s', (input, expected) => {
    expect(parsePdfDate(input)).toBe(expected);
  });

  it('writes page ranges', () => {
    expect(pageRanges([1])).toBe('1');
    expect(pageRanges([1, 2, 3, 5, 7, 8])).toBe('1-3, 5, 7-8');
  });
});
