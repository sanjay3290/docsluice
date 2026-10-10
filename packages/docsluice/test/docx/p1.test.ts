import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Budget } from '../../src/core/budget.js';
import { extract } from '../../src/core/extract.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { toJSON } from '../../src/render/json.js';
import { toMarkdown } from '../../src/render/markdown.js';
import { MathBuilder } from '../../src/readers/docx/math.js';
import { writeCfb } from '../../src/ole/write.js';
import { makeZip } from '../helpers/zip.js';

const update =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UPDATE_GOLDEN ===
  '1';
const corpus = new URL('../../../../corpus/docx/', import.meta.url);
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(name, corpus)));
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const encode = (value: string) => new TextEncoder().encode(value);
const MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

function docx(
  body: string,
  extra: { styles?: string; rels?: string; parts?: Array<{ name: string; data: Uint8Array }> } = {},
): Uint8Array {
  const rels = `${extra.styles === undefined ? '' : `<Relationship Id="rIdS" Type="${R}/styles" Target="styles.xml"/>`}${extra.rels ?? ''}`;
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: encode(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${MAIN}"/></Types>`,
      ),
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: encode(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
      ),
    },
    {
      name: 'word/document.xml',
      data: encode(
        `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:m="${M}" xmlns:o="urn:schemas-microsoft-com:office:office"><w:body>${body}</w:body></w:document>`,
      ),
    },
    ...(extra.styles === undefined
      ? []
      : [{ name: 'word/styles.xml', data: encode(`<w:styles xmlns:w="${W}">${extra.styles}</w:styles>`) }]),
    ...(extra.parts ?? []),
  ]);
}
const texts = async (bytes: Uint8Array, options = {}) =>
  (await extract(bytes, options)).blocks.map((block) => ('text' in block ? block.text : block.kind));
const run = (text: string, props = '') =>
  `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const fld = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;

describe('DOCX hidden text (DOC-9)', () => {
  it('matches the reviewed includeHidden output of the corpus file', async () => {
    const doc = await extract(fixture('hidden-text.docx'), {
      filename: 'hidden-text.docx',
      includeHidden: true,
    });
    const json = toJSON(doc, { stable: true });
    const markdown = toMarkdown(doc);
    const jsonPath = new URL('hidden-text.docx.include-hidden.expected.json', corpus);
    const markdownPath = new URL('hidden-text.docx.include-hidden.expected.md', corpus);
    if (update) {
      writeFileSync(jsonPath, json);
      writeFileSync(markdownPath, markdown);
      return;
    }
    expect(existsSync(jsonPath)).toBe(true);
    expect(json).toBe(readFileSync(jsonPath, 'utf8'));
    expect(markdown).toBe(readFileSync(markdownPath, 'utf8'));
  });

  it('leaves hidden runs out by default with one warning, and keeps them with includeHidden', async () => {
    const bytes = docx(`<w:p>${run('a ')}${run('secret ', '<w:vanish/>')}${run('b')}</w:p>`);
    const hidden = await extract(bytes);
    expect(hidden.blocks).toMatchObject([{ kind: 'paragraph', text: 'a b' }]);
    expect(hidden.warnings).toEqual([
      { code: 'HIDDEN_CONTENT', message: 'Hidden text was left out; set includeHidden to keep it.' },
    ]);
    const shown = await extract(bytes, { includeHidden: true });
    expect(shown.blocks).toMatchObject([{ kind: 'paragraph', text: 'a secret b' }]);
    expect(shown.warnings).toEqual([]);
    expect((await extract(docx(`<w:p>${run('plain')}</w:p>`))).warnings).toEqual([]);
  });

  it('hides tabs, breaks and table cell text in hidden runs, and keeps runs output in step', async () => {
    const bytes = docx(
      `<w:tbl><w:tr><w:tc><w:p>${run('cell ')}<w:r><w:rPr><w:b/><w:vanish/></w:rPr><w:tab/><w:t>gone</w:t><w:br/></w:r></w:p></w:tc></w:tr></w:tbl>` +
        `<w:p>${run('x', '<w:b/>')}${run('y', '<w:b/><w:vanish/>')}</w:p>`,
    );
    const doc = await extract(bytes, { runs: true });
    expect(doc.blocks).toMatchObject([
      { kind: 'table', rows: [[{ text: 'cell' }]] },
      { kind: 'paragraph', text: 'x', runs: [{ text: 'x', bold: true }] },
    ]);
  });

  it('ignores a hidden paragraph mark and an unknown or cyclic run style', async () => {
    const styles =
      '<w:style w:type="character" w:styleId="A"><w:basedOn w:val="B"/></w:style>' +
      '<w:style w:type="character" w:styleId="B"><w:basedOn w:val="A"/></w:style>';
    const bytes = docx(
      `<w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr>${run('mark hidden only')}</w:p>` +
        `<w:p>${run('cycle ', '<w:rStyle w:val="A"/>')}${run('missing', '<w:rStyle w:val="Nope"/>')}</w:p>`,
      { styles },
    );
    expect(await texts(bytes)).toEqual(['mark hidden only', 'cycle missing']);
  });

  it('does not let a character style stand in for a paragraph style', async () => {
    const styles = '<w:style w:type="character" w:styleId="C"><w:rPr><w:vanish/></w:rPr></w:style>';
    const bytes = docx(`<w:p><w:pPr><w:pStyle w:val="C"/></w:pPr>${run('kept')}</w:p>`, { styles });
    expect(await texts(bytes)).toEqual(['kept']);
  });
});

describe('DOCX fields (DOC-10)', () => {
  it('shows only field results, not codes or results nested in codes', async () => {
    expect(await texts(fixture('fields.docx'))).toContain('Plan: Premium.');
  });

  it('survives unbalanced field characters without losing later text', async () => {
    const bytes = docx(
      `<w:p>${fld('end')}${fld('separate')}${run('a')}</w:p>` +
        `<w:p>${fld('begin')}<w:r><w:instrText>BROKEN</w:instrText></w:r>${run('code')}</w:p>` +
        `<w:p>${run('after')}${fld('separate')}${run(' result')}${fld('end')}${fld('end')}</w:p>`,
    );
    expect(await texts(bytes)).toEqual(['a', 'after result']);
  });

  it('counts fields nested past the tracked depth without losing balance', async () => {
    const depth = 70;
    const opens = `${fld('begin')}`.repeat(depth);
    const closes = `${fld('separate')}${fld('end')}`.repeat(depth);
    const bytes = docx(`<w:p>${opens}${run('code')}${closes}${run('tail')}</w:p>`);
    expect(await texts(bytes)).toEqual(['tail']);
  });

  it('ignores field characters inside deleted revisions', async () => {
    const bytes = docx(`<w:p><w:del w:id="1">${fld('begin')}</w:del>${run('kept')}</w:p>`);
    expect(await texts(bytes)).toEqual(['kept']);
  });
});

describe('DOCX Office Math (DOC-11)', () => {
  it('renders the corpus equations as linear text', async () => {
    const lines = await texts(fixture('equations.docx'));
    expect(lines).toEqual([
      'Equations',
      'The roots are x=(−b±√(b^2−4ac))/(2a).',
      '∑_(i=1)^n i=(n(n+1))/2',
      'Indices: x_1+a_i^2, ∛(x)',
      'Identity: I=(1, 0; 0, 1)',
      'Calculus: ∫_0^1 x^2dx, sin(θ), lim_(n→∞)a^n',
      'Brackets: [a;b], x̂',
    ]);
  });

  it('renders the remaining structures and property defaults', () => {
    const builder = new MathBuilder(new Budget(DEFAULT_LIMITS));
    const element = (name: string, inner: () => void) => {
      builder.open(name);
      inner();
      return builder.close();
    };
    const text = (name: string, value: string) => element(name, () => builder.text(value));
    expect(builder.open('e')).toBe(false);
    expect(builder.close()).toBeUndefined();
    const result = element('oMathPara', () => {
      element('oMath', () => {
        element('sPre', () => {
          text('sub', '1');
          text('sup', '2');
          text('e', 'X');
        });
        element('limUpp', () => {
          text('e', 'max');
          text('lim', 'k');
        });
        element('nary', () => {
          builder.property('chr', '∏');
          builder.property('subHide', '1');
          builder.property('supHide', undefined);
          text('sub', 'hidden');
          text('sup', 'hidden');
          text('e', 'a');
        });
        element('rad', () => {
          text('deg', '5');
          text('e', 'y');
        });
        element('rad', () => {
          text('deg', '4');
          text('e', 'z');
        });
        element('d', () => {
          builder.property('begChr', undefined);
          builder.property('sepChr', ',');
          text('e', 'p');
          text('e', 'q');
        });
        element('m', () => element('mr', () => text('e', '1')));
        element('func', () => {
          text('fName', 'log');
          text('e', '(x)');
        });
        element('box', () => text('e', 'B'));
        element('acc', () => {
          builder.property('chr', undefined);
          text('e', 'v');
        });
      });
      element('oMath', () =>
        element('eqArr', () => {
          text('e', 'u=1');
          text('e', 'w=2');
        }),
      );
    });
    expect(result).toBe('_1^2Xmax^k∏ a√[5](y)∜(z)(p,q)[1]log(x)Bv̂\nu=1\nw=2');
  });
});

describe('DOCX embedded objects (DOC-12, NST-1)', () => {
  it('reads embedded packages and OLE Package streams as child documents', async () => {
    const doc = await extract(fixture('embedded-objects.docx'));
    const children = doc.children ?? [];
    expect(children.map((child) => [child.path, child.status])).toEqual([
      ['word/media/preview.png', 'listed'],
      ['word/embeddings/Microsoft_Excel_Worksheet.xlsx', 'extracted'],
      ['word/embeddings/oleObject1.bin/Package', 'extracted'],
    ]);
    expect(children[1]!.document?.blocks).toMatchObject([
      {
        kind: 'section',
        title: 'Budget',
        blocks: [
          {
            kind: 'table',
            rows: [
              [{ text: 'Item' }, { text: 'Cost' }],
              [{ text: 'Pump' }, { text: '120' }],
            ],
          },
        ],
      },
    ]);
    expect(children[2]!.document?.blocks).toMatchObject([
      { kind: 'paragraph', text: 'Text of the document packaged inside an OLE object.' },
    ]);
  });

  it('lists objects without reading them with children "list", and skips them with "skip"', async () => {
    const listed = await extract(fixture('embedded-objects.docx'), { children: 'list' });
    expect(listed.children?.map((child) => child.status)).toEqual(['listed', 'listed', 'listed']);
    const skipped = await extract(fixture('embedded-objects.docx'), { children: 'skip' });
    expect(skipped.children ?? []).toEqual([]);
  });

  it('offers a compound file without a Package stream, or a damaged one, whole', async () => {
    const budget = { tick() {}, checkUncompressed: () => true, addUncompressed: () => true };
    const plain = writeCfb([{ path: 'Other', type: 'stream', data: encode('x') }], budget as never)!;
    const damaged = plain.slice(0, 512);
    const object = (id: string) =>
      `<w:p><w:r><w:object><o:OLEObject Type="Embed" r:id="${id}"/></w:object></w:r></w:p>`;
    const bytes = docx(`${object('a')}${object('b')}${object('missing')}${object('gone')}`, {
      rels:
        `<Relationship Id="a" Type="${R}/oleObject" Target="embeddings/a.bin"/>` +
        `<Relationship Id="b" Type="${R}/oleObject" Target="embeddings/b.bin"/>` +
        `<Relationship Id="gone" Type="${R}/oleObject" Target="embeddings/none.bin"/>`,
      parts: [
        { name: 'word/embeddings/a.bin', data: plain },
        { name: 'word/embeddings/b.bin', data: damaged },
      ],
    });
    const doc = await extract(bytes);
    expect(doc.children?.map((child) => [child.path, child.status])).toEqual([
      ['word/embeddings/a.bin', 'failed'],
      ['word/embeddings/b.bin', 'failed'],
    ]);
  });

  it('charges children to the shared budget', async () => {
    const doc = await extract(fixture('embedded-objects.docx'), { limits: { outputChars: 60 } });
    const extracted = (doc.children ?? []).filter((child) => child.status === 'extracted');
    const childText = extracted
      .flatMap((child) => child.document?.blocks ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    const parentText = doc.blocks.map((block) => ('text' in block ? block.text : '')).join('');
    expect(parentText.length + childText.length).toBeLessThanOrEqual(60);
  });
});
