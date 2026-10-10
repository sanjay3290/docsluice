import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hostile EPUB packages: path escapes, huge manifests and spines, deep NCX nesting, a chapter bomb,
// a DRM-encrypted book, and remote and absolute references that must never be followed.
const directory = new URL('../../hostile/epub/', import.meta.url);
await mkdir(directory, { recursive: true });

function epub(opf, extra = {}, opfPath = 'OEBPS/content.opf') {
  const files = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': `<container><rootfiles><rootfile full-path="${opfPath}"/></rootfiles></container>`,
    [opfPath]: opf,
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

const opf = (manifest, spine, metadata = '') =>
  `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${metadata}</metadata><manifest>${manifest}</manifest><spine toc="ncx">${spine}</spine></package>`;

// References that escape the package, name an absolute path, or point at the network.
await writeFile(
  new URL('path-escapes.epub', directory),
  epub(
    opf(
      ['../../etc/passwd', '/etc/passwd', 'https://example.invalid/c.xhtml', '%2e%2e/%2e%2e/x.xhtml', 'file:///etc/passwd', 'ok.xhtml']
        .map((href, index) => `<item id="i${index}" href="${href}" media-type="application/xhtml+xml"/>`)
        .join(''),
      [0, 1, 2, 3, 4, 5].map((index) => `<itemref idref="i${index}"/>`).join(''),
    ),
    { 'OEBPS/ok.xhtml': '<html><body><p>Only this chapter is read.</p><img src="https://example.invalid/pixel.png"/></body></html>' },
  ),
);

// 50,000 manifest items and spine references to missing chapters.
await writeFile(
  new URL('huge-spine.epub', directory),
  epub(
    opf(
      Array.from({ length: 50_000 }, (_, index) => `<item id="c${index}" href="c${index}.xhtml" media-type="application/xhtml+xml"/>`).join(''),
      Array.from({ length: 50_000 }, (_, index) => `<itemref idref="c${index}"/>`).join(''),
    ),
  ),
);

// An NCX nested 10,000 levels deep.
await writeFile(
  new URL('deep-ncx.epub', directory),
  epub(
    opf(
      '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>',
      '<itemref idref="c"/>',
    ),
    {
      'OEBPS/toc.ncx': `<ncx><navMap>${'<navPoint><navLabel><text>t</text></navLabel><content src="c.xhtml"/>'.repeat(10_000)}${'</navPoint>'.repeat(10_000)}</navMap></ncx>`,
      'OEBPS/c.xhtml': '<p>Chapter.</p>',
    },
  ),
);

// About 40 MB of repetitive chapter markup in a small archive: the compression-ratio limit stops it.
await writeFile(
  new URL('chapter-bomb.epub', directory),
  epub(opf('<item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>', '<itemref idref="c"/>'), {
    'OEBPS/c.xhtml': `<html><body>${'<p>bomb</p>'.repeat(3_500_000)}</body></html>`,
  }),
);

// A DRM book: every chapter is listed as AES-encrypted. It is reported, never decrypted.
await writeFile(
  new URL('drm-encrypted.epub', directory),
  epub(opf('<item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>', '<itemref idref="c"/>'), {
    'META-INF/encryption.xml':
      '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OEBPS/c.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>',
    'OEBPS/c.xhtml': new Uint8Array(512).fill(0xa5),
  }),
);

// The container names a package outside the archive root.
await writeFile(new URL('container-escape.epub', directory), epub('<package/>', {}, '../outside.opf'));
