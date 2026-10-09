import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { DocBuilder } from '../../src/core/builder.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import type { ResolvedOptions } from '../../src/core/options.js';
import type { ReadContext } from '../../src/core/reader.js';
import { WarningSink } from '../../src/core/warnings.js';
import { openZip } from '../../src/zip/index.js';
import { makeZip } from '../helpers/zip.js';
import { defaultReader } from '../../src/readers/docx/index.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const STYLES_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';
const MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const enc = (text: string) => new TextEncoder().encode(text);

function options(): ResolvedOptions {
  return {
    limits: { ...DEFAULT_LIMITS },
    onLimit: 'truncate',
    strict: false,
    metadata: true,
    children: 'extract',
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: false,
  };
}

function packageTypes(mainPath = 'custom/main.xml', stylePath = 'custom/styles.xml'): string {
  return `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${mainPath}" ContentType="${MAIN_TYPE}"/><Override PartName="/${stylePath}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
}

function packageRelationships(mainPath = 'custom/main.xml'): string {
  return `<Relationships xmlns="${RELS}"><Relationship Id="root-doc" Type="${OFFICE_REL}" Target="/${mainPath}"/></Relationships>`;
}

function partRelationships(stylePath = 'custom/styles.xml'): string {
  return `<Relationships xmlns="${RELS}"><Relationship Id="style" Type="${STYLES_REL}" Target="/${stylePath}"/></Relationships>`;
}

async function extractFixture(entries: Array<{ name: string; data: string }>, reuseZip = true) {
  const bytes = makeZip(entries.map((entry) => ({ name: entry.name, data: enc(entry.data) })));
  const warnings = new WarningSink();
  const budget = new Budget({ ...DEFAULT_LIMITS }, { warnings });
  const opts = options();
  const out = new DocBuilder(
    'docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    budget,
    opts,
  );
  const ctx: ReadContext = {
    bytes,
    options: opts,
    budget,
    warnings,
    out,
    path: '',
    async extractChild() {},
    ...(reuseZip ? { zip: openZip(bytes, budget) } : {}),
  };
  await defaultReader.read(ctx);
  return { document: out.finish(), warnings };
}

describe('DOCX reader', () => {
  it('follows the officeDocument relationship and its styles relationship', async () => {
    const result = await extractFixture([
      { name: '[Content_Types].xml', data: packageTypes() },
      { name: '_rels/.rels', data: packageRelationships() },
      { name: 'custom/_rels/main.xml.rels', data: partRelationships() },
      {
        name: 'custom/styles.xml',
        data: `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="LocalHeading"><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>`,
      },
      {
        name: 'custom/main.xml',
        data: `<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="LocalHeading"/></w:pPr><w:r><w:t>Chosen main part</w:t></w:r></w:p></w:body></w:document>`,
      },
      {
        name: 'word/document.xml',
        data: `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Wrong fallback</w:t></w:r></w:p></w:body></w:document>`,
      },
    ]);
    expect(result.document.blocks).toMatchObject([{ kind: 'heading', level: 2, text: 'Chosen main part' }]);
  });

  it('uses canonical document.xml when the root officeDocument relationship is absent', async () => {
    const result = await extractFixture(
      [
        {
          name: 'word/document.xml',
          data: `<!DOCTYPE w:document SYSTEM "file:///must-not-read"><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Fallback</w:t></w:r></w:p></w:body></w:document>`,
        },
      ],
      false,
    );
    expect(result.document.blocks).toMatchObject([{ kind: 'paragraph', text: 'Fallback' }]);
    expect(result.document.warnings.map((warning) => warning.code)).toContain('DTD_IGNORED');
  });

  it('ignores extension-nested style records beneath a valid styles root', async () => {
    const result = await extractFixture([
      { name: '_rels/.rels', data: packageRelationships() },
      { name: 'custom/_rels/main.xml.rels', data: partRelationships() },
      {
        name: 'custom/styles.xml',
        data: `<w:styles xmlns:w="${W}" xmlns:e="urn:extension"><e:wrapper><w:style w:type="paragraph" w:styleId="Forged"><w:name w:val="Heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></e:wrapper></w:styles>`,
      },
      {
        name: 'custom/main.xml',
        data: `<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="Forged"/></w:pPr><w:r><w:t>ordinary paragraph</w:t></w:r></w:p></w:body></w:document>`,
      },
    ]);
    expect(result.document.blocks).toMatchObject([{ kind: 'paragraph', text: 'ordinary paragraph' }]);
    expect(result.document.warnings.map((warning) => warning.code)).not.toContain('UNREADABLE_PART');
  });

  it('rejects a main part with the wrong root namespace', async () => {
    const result = await extractFixture([
      { name: '_rels/.rels', data: packageRelationships('word/document.xml') },
      {
        name: 'word/document.xml',
        data: `<e:document xmlns:e="urn:extension"><e:body><w:p xmlns:w="${W}"><w:r><w:t>Wrong root</w:t></w:r></w:p></e:body></e:document>`,
      },
    ]);
    expect(result.document.blocks).toEqual([]);
    expect(result.document.warnings.map((warning) => warning.code)).toContain('UNREADABLE_PART');
  });

  it('handles 10,000 nested content controls within XML depth limits', async () => {
    const nested = `${'<w:sdt>'.repeat(10_000)}<w:sdtContent><w:p><w:r><w:t>deep</w:t></w:r></w:p></w:sdtContent>${'</w:sdt>'.repeat(10_000)}`;
    const result = await extractFixture([
      { name: '_rels/.rels', data: packageRelationships('word/document.xml') },
      {
        name: 'word/document.xml',
        data: `<w:document xmlns:w="${W}"><w:body>${nested}</w:body></w:document>`,
      },
    ]);
    expect(
      result.document.warnings.some(
        (warning) => warning.code === 'TRUNCATED' || warning.code === 'DEPTH_LIMIT',
      ),
    ).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'deep')).toBe(false);
  });

  it('keeps __proto__ style ids in Maps and uses the first duplicate style definition', async () => {
    const result = await extractFixture([
      { name: '_rels/.rels', data: packageRelationships('word/document.xml') },
      { name: 'word/_rels/document.xml.rels', data: partRelationships('word/styles.xml') },
      {
        name: 'word/styles.xml',
        data: `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="__proto__"><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="__proto__"><w:pPr><w:outlineLvl w:val="4"/></w:pPr></w:style></w:styles>`,
      },
      {
        name: 'word/document.xml',
        data: `<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="__proto__"/></w:pPr><w:r><w:t>Safe map id</w:t></w:r></w:p></w:body></w:document>`,
      },
    ]);
    expect(result.document.blocks).toMatchObject([{ kind: 'heading', level: 1, text: 'Safe map id' }]);
    expect(result.document.warnings.map((warning) => warning.code)).toContain('UNREADABLE_PART');
  });
});
