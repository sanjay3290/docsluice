import { describe, expect, it } from 'vitest';
import { createExtractor } from '../../src/core/extract.js';
import { ReaderRegistry } from '../../src/core/registry.js';
import { odpReader } from '../../src/readers/odp/index.js';
import { toMarkdown } from '../../src/render/markdown.js';
import { toText } from '../../src/render/text.js';
import { makeZip } from '../helpers/zip.js';

const encoder = new TextEncoder();
const officeNs = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const drawNs = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
const presentationNs = 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0';
const textNs = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const xlinkNs = 'http://www.w3.org/1999/xlink';

function odpPackage(): Uint8Array {
  return makeZip([
    {
      name: 'mimetype',
      data: encoder.encode('application/vnd.oasis.opendocument.presentation'),
    },
    {
      name: 'content.xml',
      data: encoder.encode(
        `<office:document-content xmlns:office="${officeNs}" xmlns:draw="${drawNs}" xmlns:presentation="${presentationNs}" xmlns:text="${textNs}" xmlns:xlink="${xlinkNs}"><office:body><office:presentation><draw:page><draw:frame presentation:class="title"><draw:text-box><text:p>Privacy-safe title</text:p></draw:text-box></draw:frame><draw:frame><draw:image xlink:href="Pictures/pixel.png"/></draw:frame><presentation:notes><draw:frame><draw:text-box><text:p>Speaker notes</text:p><text:creator>Private note author</text:creator></draw:text-box></draw:frame></presentation:notes></draw:page></office:presentation></office:body></office:document-content>`,
      ),
    },
    {
      name: 'meta.xml',
      data: encoder.encode(
        `<office:document-meta xmlns:office="${officeNs}" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:title>Visible title</dc:title><dc:creator>Private author</dc:creator></office:meta></office:document-meta>`,
      ),
    },
    { name: 'Pictures/pixel.png', data: new Uint8Array([1, 2, 3, 4]) },
  ]);
}

describe('ODP extraction pipeline', () => {
  it('detects the ZIP mimetype, preserves notes, exposes requested image bytes, and respects metadata privacy', async () => {
    const registry = new ReaderRegistry();
    registry.add({ id: 'odp', mimeTypes: odpReader.mimeTypes, load: () => Promise.resolve(odpReader) });
    const document = await createExtractor(registry)(odpPackage(), {
      childBytes: true,
      children: 'list',
      metadata: false,
    });

    expect(document.format).toBe('odp');
    expect(document.metadata).toEqual({ title: 'Visible title' });
    expect(document.children[0]).toMatchObject({
      path: 'Pictures/pixel.png',
      status: 'listed',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(document.blocks).toMatchObject([
      {
        kind: 'section',
        role: 'slide',
        title: 'Privacy-safe title',
        blocks: [{ kind: 'image' }, { kind: 'note', role: 'speaker-notes', text: 'Speaker notes' }],
      },
    ]);
    expect(toText(document)).toContain('Speaker notes');
    expect(toMarkdown(document)).toContain('Speaker notes');
    expect(JSON.stringify(document)).not.toContain('Private author');
    expect(JSON.stringify(document)).not.toContain('Private note author');
  });
});
