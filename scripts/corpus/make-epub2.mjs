import { readFile, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// An EPUB 2.0.1 package (OPF 2.0, NCX, XHTML 1.1) of the public-domain Gettysburg Address, built from
// scripts/corpus/src/gettysburg-address.fodt so its text matches the LibreOffice EPUB 3 export.
// Output is deterministic: fixed entry order and timestamps, the stored mimetype entry first.
const source = await readFile(new URL('src/gettysburg-address.fodt', import.meta.url), 'utf8');
const paragraphs = [...source.matchAll(/<text:p(?: [^>]*)?>([^<]*)<\/text:p>/g)].map((match) => match[1]);
const [opening, second, third, delivered, textNote, statusNote] = paragraphs;
const output = new URL('../../corpus/epub/gettysburg-address-epub2.epub', import.meta.url);

const xhtml = (title, body) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en"><head><title>${title}</title></head><body>${body}</body></html>\n`;

const files = [
  ['mimetype', 'application/epub+zip'],
  [
    'META-INF/container.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n',
  ],
  [
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:title>The Gettysburg Address</dc:title><dc:creator opf:role="aut">Abraham Lincoln</dc:creator><dc:language>en</dc:language><dc:date opf:event="original-publication">1863-11-19</dc:date><dc:rights>Public domain</dc:rights><dc:identifier id="bookid">urn:docsluice:corpus:gettysburg-address-epub2</dc:identifier></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/><item id="address" href="text/address.xhtml" media-type="application/xhtml+xml"/><item id="about" href="text/about.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="cover" linear="no"/><itemref idref="address"/><itemref idref="about"/></spine><guide><reference type="text" title="Text" href="text/address.xhtml"/></guide></package>\n`,
  ],
  [
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:docsluice:corpus:gettysburg-address-epub2"/></head><docTitle><text>The Gettysburg Address</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>The Gettysburg Address</text></navLabel><content src="text/address.xhtml"/><navPoint id="n1a" playOrder="2"><navLabel><text>Second paragraph</text></navLabel><content src="text/address.xhtml#p2"/></navPoint></navPoint><navPoint id="n2" playOrder="3"><navLabel><text>About This Edition</text></navLabel><content src="text/about.xhtml"/></navPoint></navMap></ncx>\n`,
  ],
  ['OEBPS/text/cover.xhtml', xhtml('Cover', '<p>The Gettysburg Address — cover page</p>')],
  [
    'OEBPS/text/address.xhtml',
    xhtml(
      'The Gettysburg Address',
      `<h1>The Gettysburg Address</h1><p>${opening}</p><p id="p2">${second}</p><p>${third}</p>`,
    ),
  ],
  [
    'OEBPS/text/about.xhtml',
    xhtml('About This Edition', `<h1>About This Edition</h1><p>${delivered}</p><ul><li>${textNote}</li><li>${statusNote}</li></ul>`),
  ],
];
const entries = Object.create(null);
for (const [name, text] of files) {
  entries[name] = [strToU8(text), { mtime: new Date('1980-01-01T00:00:00Z'), level: name === 'mimetype' ? 0 : 9 }];
}
await writeFile(output, zipSync(entries));
await writeFile(
  new URL(`${output.href}.license`),
  'SPDX-License-Identifier: CC0-1.0\nSource: made for docsluice by scripts/corpus/make-epub2.mjs from scripts/corpus/src/gettysburg-address.fodt\nRequirements: HTM-1\nText: The Gettysburg Address by Abraham Lincoln (1863, Bliss copy), in the public domain.\n',
);
