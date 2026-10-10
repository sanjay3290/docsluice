import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hostile ODP packages: groups and lists nested past every depth limit, a slide table with
// repeat floods, a billion-space text:s, 8,000 slides and lengths that are not numbers.
const OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const DRAW = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
const PRESENTATION = 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0';
const SVG = 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0';
const TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const directory = new URL('../../hostile/odp/', import.meta.url);
await mkdir(directory, { recursive: true });

function odp(pages) {
  const content = `<office:document-content xmlns:office="${OFFICE}" xmlns:draw="${DRAW}" xmlns:presentation="${PRESENTATION}" xmlns:svg="${SVG}" xmlns:table="${TABLE}" xmlns:text="${TEXT}"><office:body><office:presentation>${pages}</office:presentation></office:body></office:document-content>`;
  const entries = Object.create(null);
  for (const [name, data] of [
    ['mimetype', 'application/vnd.oasis.opendocument.presentation'],
    ['content.xml', content],
  ]) {
    entries[name] = [strToU8(data), { mtime: new Date('1980-01-01T00:00:00Z'), level: name === 'mimetype' ? 0 : 9 }];
  }
  return zipSync(entries);
}

const frame = (inner, x = '1cm', y = '1cm') =>
  `<draw:frame svg:x="${x}" svg:y="${y}"><draw:text-box>${inner}</draw:text-box></draw:frame>`;

const files = new Map([
  ['nested-groups.odp', odp(`<draw:page>${'<draw:g>'.repeat(10_000)}${frame('<text:p>deep</text:p>')}${'</draw:g>'.repeat(10_000)}</draw:page>`)],
  [
    'nested-lists.odp',
    odp(
      `<draw:page>${frame(`${'<text:list><text:list-item>'.repeat(5_000)}<text:p>deep</text:p>${'</text:list-item></text:list>'.repeat(5_000)}`)}</draw:page>`,
    ),
  ],
  [
    'table-repeat-flood.odp',
    odp(
      `<draw:page><draw:frame svg:x="0cm" svg:y="0cm"><table:table>${`<table:table-row><table:table-cell table:number-columns-repeated="999999999" table:number-columns-spanned="999999999" table:number-rows-spanned="999999999"><text:p>x</text:p></table:table-cell></table:table-row>`.repeat(200)}</table:table></draw:frame></draw:page>`,
    ),
  ],
  ['huge-space-count.odp', odp(`<draw:page>${frame('<text:p>a<text:s text:c="999999999"/>b</text:p>')}</draw:page>`)],
  ['many-slides.odp', odp(`<draw:page>${frame('<text:p>s</text:p>')}</draw:page>`.repeat(8_000))],
  [
    'bad-lengths.odp',
    odp(
      `<draw:page>${['NaNcm', '1e999cm', '-0', '9'.repeat(40) + 'cm', '1cmcm', ''].map((length) => frame('<text:p>x</text:p>', length, length)).join('')}</draw:page>`,
    ),
  ],
]);

for (const [name, bytes] of files) await writeFile(new URL(name, directory), bytes);
