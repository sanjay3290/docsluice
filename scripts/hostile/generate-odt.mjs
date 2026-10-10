import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hostile ODT packages: deep lists and tables, a content bomb, repeated-cell and span floods, style cycles,
// prototype-named styles, manifest path tricks and an encrypted manifest entry.
const OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const STYLE = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
const DRAW = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
const XLINK = 'http://www.w3.org/1999/xlink';
const MANIFEST = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0';
const directory = new URL('../../hostile/odt/', import.meta.url);
await mkdir(directory, { recursive: true });

function odt(contentXml, extra = {}) {
  const files = {
    mimetype: 'application/vnd.oasis.opendocument.text',
    'content.xml': contentXml,
    ...extra,
  };
  const entries = Object.create(null);
  for (const [name, content] of Object.entries(files)) {
    entries[name] = [
      typeof content === 'string' ? strToU8(content) : content,
      { mtime: new Date('1980-01-01T00:00:00Z'), level: name === 'mimetype' ? 0 : 9 },
    ];
  }
  return zipSync(entries);
}

const content = (inner, styles = '') =>
  `<office:document-content xmlns:office="${OFFICE}" xmlns:text="${TEXT}" xmlns:table="${TABLE}" xmlns:style="${STYLE}" xmlns:draw="${DRAW}" xmlns:xlink="${XLINK}"><office:automatic-styles>${styles}</office:automatic-styles><office:body><office:text>${inner}</office:text></office:body></office:document-content>`;
const p = (text) => `<text:p>${text}</text:p>`;
const manifest = (entries) =>
  `<manifest:manifest xmlns:manifest="${MANIFEST}"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>${entries}</manifest:manifest>`;

await writeFile(
  new URL('deep-lists-10000.odt', directory),
  odt(content(`${'<text:list><text:list-item>'.repeat(10_000)}${p('deep')}${'</text:list-item></text:list>'.repeat(10_000)}${p('after')}`)),
);

await writeFile(
  new URL('deep-tables-1000.odt', directory),
  odt(content(`${'<table:table><table:table-row><table:table-cell>'.repeat(1_000)}${p('deep')}${'</table:table-cell></table:table-row></table:table>'.repeat(1_000)}`)),
);

// About 40 MB of repetitive paragraph XML in a small archive: the compression-ratio limit must stop it.
await writeFile(new URL('content-bomb.odt', directory), odt(content(p('bomb').repeat(3_000_000))));

// Cells that claim huge repeats and spans: repeats are capped and charged to the cells limit.
await writeFile(
  new URL('repeated-cells-flood.odt', directory),
  odt(
    content(
      `<table:table>${`<table:table-row><table:table-cell table:number-columns-repeated="99999999"><text:p>x</text:p></table:table-cell><table:table-cell table:number-columns-spanned="99999999" table:number-rows-spanned="99999999"/></table:table-row>`.repeat(300)}</table:table>`,
    ),
  ),
);

// Parent-style cycles and prototype-named styles must not loop or pollute objects.
await writeFile(
  new URL('style-cycle-proto.odt', directory),
  odt(
    content(
      `<text:h text:style-name="__proto__">Proto heading</text:h><text:p text:style-name="A">Cycle</text:p><text:list text:style-name="constructor"><text:list-item>${p('item')}</text:list-item></text:list>`,
      `<style:style style:name="A" style:family="paragraph" style:parent-style-name="B"/><style:style style:name="B" style:family="paragraph" style:parent-style-name="A"/><style:style style:name="__proto__" style:family="paragraph" style:parent-style-name="__proto__"/>`,
    ),
  ),
);

// Images whose paths escape the package or point at the network: never read, never fetched.
await writeFile(
  new URL('image-path-tricks.odt', directory),
  odt(
    content(
      ['../../etc/passwd', '/etc/passwd', 'https://example.invalid/pixel.png', 'Pictures/%2e%2e/x.png', 'Pictures/missing.png']
        .map((href) => `<text:p><draw:frame><draw:image xlink:href="${href}"/></draw:frame></text:p>`)
        .join(''),
    ),
    {
      'META-INF/manifest.xml': manifest(
        '<manifest:file-entry manifest:full-path="../../etc/passwd" manifest:media-type="image/png"/><manifest:file-entry manifest:full-path="Pictures/missing.png" manifest:media-type="image/png"/>',
      ),
    },
  ),
);

await writeFile(
  new URL('encrypted-manifest.odt', directory),
  odt(content(p('secret')), {
    'META-INF/manifest.xml': manifest(
      '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"><manifest:encryption-data manifest:checksum-type="SHA1/1K" manifest:checksum="AAAA"><manifest:algorithm manifest:algorithm-name="Blowfish CFB" manifest:initialisation-vector="AAAA"/></manifest:encryption-data></manifest:file-entry>',
    ),
  }),
);
