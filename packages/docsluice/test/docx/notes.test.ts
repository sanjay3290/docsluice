import { describe, expect, it } from 'vitest';
import { extract } from '../../src/core/extract.js';
import { makeZip } from '../helpers/zip.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const encode = (value: string) => new TextEncoder().encode(value);
const p = (inner: string) => `<w:p>${inner}</w:p>`;
const t = (text: string) => `<w:r><w:t>${text}</w:t></w:r>`;

function docx(body: string, parts: Record<string, string>, rels: string): Uint8Array {
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: encode(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: 'word/document.xml',
      data: encode(`<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`),
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: encode(`<Relationships xmlns="${PKG}">${rels}</Relationships>`),
    },
    ...Object.entries(parts).map(([name, xml]) => ({ name, data: encode(xml) })),
  ]);
}
const rel = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`;
const story = (root: string, text: string) => `<w:${root} xmlns:w="${W}">${p(t(text))}</w:${root}>`;

describe('DOCX headers, footers, notes and comments', () => {
  it('emits each distinct header before the body and each distinct footer after it', async () => {
    const sect = (header: string, footer: string) =>
      `<w:sectPr><w:headerReference w:type="default" r:id="${header}"/><w:footerReference w:type="default" r:id="${footer}"/></w:sectPr>`;
    const doc = await extract(
      docx(
        p(t('Section one') + `<w:pPr>${sect('h1', 'f1')}</w:pPr>`) + p(t('Section two')) + sect('h2', 'f2'),
        {
          'word/header1.xml': story('hdr', 'Shared header'),
          'word/header2.xml': story('hdr', 'Shared header'),
          'word/footer1.xml': story('ftr', 'First footer'),
          'word/footer2.xml': story('ftr', 'Second footer'),
        },
        rel('h1', 'header', 'header1.xml') +
          rel('h2', 'header', 'header2.xml') +
          rel('f1', 'footer', 'footer1.xml') +
          rel('f2', 'footer', 'footer2.xml'),
      ),
    );
    expect(doc.blocks.map((block) => [block.kind, 'text' in block ? block.text : ''])).toEqual([
      ['header', 'Shared header'],
      ['paragraph', 'Section one'],
      ['paragraph', 'Section two'],
      ['footer', 'First footer'],
      ['footer', 'Second footer'],
    ]);
    expect(doc.blocks[0]!.loc.path).toBe('word/header1.xml');
  });

  it('places notes after their paragraph, skips separators and keeps comment authors unless metadata is off', async () => {
    const footnotes = `<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1">${p('<w:r><w:separator/></w:r>')}</w:footnote><w:footnote w:type="continuationSeparator" w:id="0">${p(t('sep'))}</w:footnote><w:footnote w:id="1">${p(t('Foot one'))}</w:footnote></w:footnotes>`;
    const comments = `<w:comments xmlns:w="${W}"><w:comment w:id="7" w:author="Ada" w:initials="AL">${p(t('Check this'))}</w:comment><w:comment w:id="8" w:initials="LN">${p(t('Initials only'))}</w:comment></w:comments>`;
    const body =
      p(t('Plain')) +
      '<w:commentRangeStart w:id="7"/>' +
      p(t('Commented') + '<w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r>') +
      p(
        t('Has a footnote') +
          '<w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:footnoteReference w:id="99"/></w:r>',
      ) +
      p(t('Second comment') + '<w:r><w:commentReference w:id="8"/></w:r>');
    const bytes = docx(
      body,
      { 'word/footnotes.xml': footnotes, 'word/comments.xml': comments },
      rel('fn', 'footnotes', 'footnotes.xml') + rel('cm', 'comments', 'comments.xml'),
    );
    const doc = await extract(bytes);
    expect(
      doc.blocks.map((block) => [
        block.kind,
        'text' in block ? block.text : '',
        block.kind === 'note' ? (block.author ?? '') : '',
      ]),
    ).toEqual([
      ['paragraph', 'Plain', ''],
      ['paragraph', 'Commented', ''],
      ['note', 'Check this', 'Ada'],
      ['paragraph', 'Has a footnote', ''],
      ['note', 'Foot one', ''],
      ['paragraph', 'Second comment', ''],
      ['note', 'Initials only', 'LN'],
    ]);
    expect(
      doc.blocks.filter((block) => block.kind === 'note').map((block) => block.kind === 'note' && block.role),
    ).toEqual(['comment', 'footnote', 'comment']);
    const anonymous = await extract(bytes, { metadata: false });
    expect(anonymous.blocks.some((block) => block.kind === 'note' && block.author !== undefined)).toBe(false);
  });

  it('emits notes from list items after the list and from table cells after the table', async () => {
    const numbering = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
    const endnotes = `<w:endnotes xmlns:w="${W}"><w:endnote w:id="1">${p(t('List note'))}</w:endnote><w:endnote w:id="2">${p(t('Cell note'))}</w:endnote></w:endnotes>`;
    const item = (text: string, note = '') =>
      p(`<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${t(text)}${note}`);
    const body =
      item('one', '<w:r><w:endnoteReference w:id="1"/></w:r>') +
      item('two') +
      `<w:tbl><w:tr><w:tc>${p(t('cell') + '<w:r><w:endnoteReference w:id="2"/></w:r>')}</w:tc></w:tr></w:tbl>` +
      p(t('after'));
    const doc = await extract(
      docx(
        body,
        { 'word/numbering.xml': numbering, 'word/endnotes.xml': endnotes },
        rel('n', 'numbering', 'numbering.xml') + rel('e', 'endnotes', 'endnotes.xml'),
      ),
    );
    expect(doc.blocks.map((block) => block.kind)).toEqual(['list', 'note', 'table', 'note', 'paragraph']);
    expect(
      doc.blocks.filter((block) => block.kind === 'note').map((block) => block.kind === 'note' && block.text),
    ).toEqual(['List note', 'Cell note']);
  });
});
