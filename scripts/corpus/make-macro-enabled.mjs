// Macro-enabled corpus files (.docm, .xlsm, .pptm) made from CC0 corpus files: the main part gets its
// macro-enabled content type and the package gets a VBA project part with a relationship to it.
// The project is an inert compound file (a PROJECT stream and an empty VBA storage): it holds no
// code, which is all docsluice ever looks at (it reports macros, never reads or runs them).
import { readFile, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { TextDecoder, TextEncoder } from 'node:util';
import { unzipSync, zipSync } from 'fflate';
import { writeCfb } from '../../packages/docsluice/src/ole/write.ts';

const corpus = new URL('../../corpus/', import.meta.url);
const budget = { tick() {}, checkUncompressed: () => true, addUncompressed: () => true };
const VBA_TYPE = 'application/vnd.ms-office.vbaProject';
const VBA_RELATIONSHIP = 'http://schemas.microsoft.com/office/2006/relationships/vbaProject';

const project = writeCfb(
  [
    { path: 'PROJECT', type: 'stream', data: new TextEncoder().encode('Name="DocsluiceFixture"\r\n') },
    { path: 'VBA', type: 'storage' },
  ],
  budget,
);

const variants = [
  {
    source: 'docx/headings-outline.docx',
    target: 'docx/headings-outline-macros.docm',
    main: '/word/document.xml',
    type: 'application/vnd.ms-word.document.macroEnabled.main+xml',
    rels: 'word/_rels/document.xml.rels',
    part: 'word/vbaProject.bin',
  },
  {
    source: 'xlsx/workbook-values-formulas.xlsx',
    target: 'xlsx/workbook-values-formulas-macros.xlsm',
    main: '/xl/workbook.xml',
    type: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
    rels: 'xl/_rels/workbook.xml.rels',
    part: 'xl/vbaProject.bin',
  },
  {
    source: 'pptx/deck-hidden-notes.pptx',
    target: 'pptx/deck-hidden-notes-macros.pptm',
    main: '/ppt/presentation.xml',
    type: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
    rels: 'ppt/_rels/presentation.xml.rels',
    part: 'ppt/vbaProject.bin',
  },
];

const text = (bytes) => new TextDecoder().decode(bytes);
const bytes = (value) => new TextEncoder().encode(value);

for (const variant of variants) {
  const files = unzipSync(new Uint8Array(await readFile(new URL(variant.source, corpus))));
  const types = text(files['[Content_Types].xml']);
  const override = new RegExp(`(<Override PartName="${variant.main}" ContentType=")[^"]+(")`);
  if (!override.test(types)) throw new Error(`${variant.source} has no override for ${variant.main}`);
  files['[Content_Types].xml'] = bytes(
    types
      .replace(override, `$1${variant.type}$2`)
      .replace('</Types>', `<Default Extension="bin" ContentType="${VBA_TYPE}"/></Types>`),
  );
  files[variant.rels] = bytes(
    text(files[variant.rels]).replace(
      '</Relationships>',
      `<Relationship Id="rIdVba" Type="${VBA_RELATIONSHIP}" Target="vbaProject.bin"/></Relationships>`,
    ),
  );
  files[variant.part] = project;
  const entries = Object.create(null);
  for (const name of Object.keys(files).sort()) {
    // [Content_Types].xml first, as Office writes it; fixed times keep the output byte-stable.
    entries[name] = [files[name], { mtime: new Date('1980-01-01T00:00:00Z'), level: 9 }];
  }
  const ordered = Object.create(null);
  ordered['[Content_Types].xml'] = entries['[Content_Types].xml'];
  for (const name of Object.keys(entries)) if (name !== '[Content_Types].xml') ordered[name] = entries[name];
  await writeFile(new URL(variant.target, corpus), zipSync(ordered));
}
