import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import type { WarningCode } from '../../src/core/model.js';
import { WarningSink } from '../../src/core/warnings.js';
import type { XmlContext } from '../../src/xml/index.js';
import { parseOdfMetadata } from '../../src/odf/meta.js';
import { parseOdfManifest } from '../../src/odf/manifest.js';
import { parseOdfStyles, resolveOdfStyle } from '../../src/odf/styles.js';

function context(
  options: {
    strict?: boolean | readonly WarningCode[];
    xmlDepth?: number;
    signal?: AbortSignal;
  } = {},
) {
  const warnings = new WarningSink({ strict: options.strict });
  const ctx: XmlContext = {
    budget: new Budget(
      { ...DEFAULT_LIMITS, ...(options.xmlDepth ? { xmlDepth: options.xmlDepth } : {}) },
      {
        warnings,
        signal: options.signal,
      },
    ),
    warnings,
  };
  return { ...ctx, warnings };
}

describe('ODF metadata helpers', () => {
  it('maps namespace-qualified Dublin Core and ODF metadata fields', () => {
    const result = parseOdfMetadata(
      `<x:document-meta xmlns:x="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:d="http://purl.org/dc/elements/1.1/" xmlns:m="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><x:meta><d:title>Sample</d:title><d:creator>Ada</d:creator><m:initial-creator>Grace</m:initial-creator><d:date>2024-02-03T04:05:06Z</d:date><m:creation-date>2024-01-02T03:04:05Z</m:creation-date><d:language>en</d:language><m:document-statistic m:page-count="12"/><m:user-defined m:name="custom-key">custom value</m:user-defined></x:meta></x:document-meta>`,
      context(),
    );
    expect(result).toEqual({
      title: 'Sample',
      authors: ['Ada', 'Grace'],
      created: '2024-01-02T03:04:05.000Z',
      modified: '2024-02-03T04:05:06.000Z',
      pageCount: 12,
      language: 'en',
      custom: [{ name: 'custom-key', value: 'custom value' }],
    });
  });

  it('normalizes LibreOffice nanosecond dates without relying on engine-specific Date parsing', () => {
    const meta = (date: string) =>
      parseOdfMetadata(
        new TextEncoder().encode(
          `<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><meta:creation-date>${date}</meta:creation-date></office:meta></office:document-meta>`,
        ),
        context(),
      ).created;
    expect(meta('2026-10-09T14:42:00.123456789')).toBe('2026-10-09T14:42:00.123Z');
    expect(meta('2026-10-09T14:42:00.5+02:00')).toBe('2026-10-09T12:42:00.500Z');
    expect(meta('2026-10-09T14:42:00')).toBe('2026-10-09T14:42:00.000Z');
    expect(meta('2026-10-09')).toBe('2026-10-09T00:00:00.000Z');
  });
  it('accepts flat documents but reads only fields directly under office:meta', () => {
    const result = parseOdfMetadata(
      `<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:ext="urn:example:extension"><office:meta><dc:title>Direct title</dc:title><ext:wrapper><dc:title>Nested title</dc:title><meta:user-defined meta:name="nested">secret</meta:user-defined></ext:wrapper></office:meta><office:body><dc:title>Body title</dc:title></office:body></office:document>`,
      context(),
    );
    expect(result).toEqual({ title: 'Direct title' });
  });

  it('ignores metadata-looking descendants outside a valid ODF metadata root', () => {
    const ctx = context();
    const result = parseOdfMetadata(
      `<extension xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Injected</dc:title></extension>`,
      ctx,
    );
    expect(result).toEqual({});
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });

  it('does not retain authors or custom properties when metadata is disabled', () => {
    const xml = `<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><dc:title>Public title</dc:title><dc:creator>Private author</dc:creator><meta:user-defined meta:name="secret">Private value</meta:user-defined></office:meta></office:document-meta>`;
    expect(parseOdfMetadata(xml, context(), { metadata: false })).toEqual({ title: 'Public title' });
  });

  it('drops invalid date/count values and keeps file-derived custom names in arrays', () => {
    const xml = `<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><dc:date>yesterday</dc:date><meta:creation-date>2024-99-99</meta:creation-date><meta:document-statistic meta:page-count="1e9"/><meta:user-defined meta:name="__proto__">safe</meta:user-defined></office:meta></office:document-meta>`;
    const result = parseOdfMetadata(xml, context());
    expect(result).toEqual({ custom: [{ name: '__proto__', value: 'safe' }] });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('ignores namespace-spoofed metadata and reports malformed XML structurally', () => {
    const ctx = context();
    const result = parseOdfMetadata(
      `<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="urn:wrong"><office:meta><dc:title>Do not accept</dc:title></office:meta><office:meta><dc:title>`,
      ctx,
    );
    expect(result).toEqual({});
    expect(ctx.warnings.warnings.map(({ code, message }) => [code, message])).toEqual([
      ['UNREADABLE_PART', 'XML ended before all elements were closed.'],
    ]);
  });

  it('ignores DTD entity declarations and preserves the XML parser warning', () => {
    const ctx = context();
    const result = parseOdfMetadata(
      `<!DOCTYPE x [<!ENTITY secret "private">]><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:title>&secret;</dc:title></office:meta></office:document-meta>`,
      ctx,
    );
    expect(result).toEqual({ title: '&secret;' });
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['DTD_IGNORED', 'UNKNOWN_ENTITY']);
  });
});

describe('ODF styles helpers', () => {
  it('parses styles by namespace and resolves parent values without recursion', () => {
    const ctx = context();
    const styles = parseOdfStyles(
      `<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"><office:styles><style:style style:name="Base" style:family="paragraph"><style:paragraph-properties style:default-outline-level="2"/></style:style><style:style style:name="Child" style:family="paragraph" style:parent-style-name="Base"/></office:styles></office:document-styles>`,
      ctx,
    );
    expect(styles.get('Child')).toMatchObject({
      name: 'Child',
      family: 'paragraph',
      parentStyleName: 'Base',
    });
    expect(resolveOdfStyle(styles, 'Child', ctx)).toEqual({
      name: 'Child',
      family: 'paragraph',
      parentStyleName: 'Base',
      outlineLevel: 2,
    });
  });

  it('preserves parser depth-limit behavior instead of traversing partial style data', () => {
    const ctx = context({ xmlDepth: 1 });
    const styles = parseOdfStyles(
      `<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"><office:styles><style:style style:name="blocked" style:family="paragraph"/></office:styles></office:document-styles>`,
      ctx,
    );
    expect(styles.size).toBe(0);
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['TRUNCATED']);
  });

  it('reports missing parents and cycles and bounds parent depth', () => {
    const ctx = context({ xmlDepth: 3 });
    const styles = parseOdfStyles(
      `<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"><office:styles><style:style style:name="a" style:family="paragraph" style:parent-style-name="b"/><style:style style:name="b" style:family="paragraph" style:parent-style-name="a"/><style:style style:name="c" style:family="paragraph" style:parent-style-name="missing"/><style:style style:name="d" style:family="paragraph" style:parent-style-name="e"/><style:style style:name="e" style:family="paragraph" style:parent-style-name="f"/><style:style style:name="f" style:family="paragraph" style:parent-style-name="g"/><style:style style:name="g" style:family="paragraph"/></office:styles></office:document-styles>`,
      ctx,
    );
    expect(resolveOdfStyle(styles, 'a', ctx)?.name).toBe('a');
    expect(resolveOdfStyle(styles, 'c', ctx)?.name).toBe('c');
    expect(resolveOdfStyle(styles, 'd', ctx)?.name).toBe('d');
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual([
      'UNREADABLE_PART',
      'UNREADABLE_PART',
      'DEPTH_LIMIT',
    ]);
  });

  it('uses Map keys for prototype-like names and rejects namespace spoofing', () => {
    const ctx = context();
    const styles = parseOdfStyles(
      `<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:x="urn:wrong"><office:styles><style:style style:name="__proto__" style:family="paragraph"/><style:style style:name="constructor" style:family="paragraph"/><style:style style:name="prototype" style:family="paragraph"/><x:style x:name="ignored" x:family="paragraph"/></office:styles></office:document-styles>`,
      ctx,
    );
    expect(styles.get('__proto__')?.family).toBe('paragraph');
    expect(styles.get('constructor')?.family).toBe('paragraph');
    expect(styles.get('prototype')?.family).toBe('paragraph');
    expect(styles.has('ignored')).toBe(false);
  });

  it('does not let a wrong-namespace duplicate attribute mask the correct attribute', () => {
    const ctx = context();
    const styles = parseOdfStyles(
      `<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:x="urn:wrong" xmlns:p="urn:oasis:names:tc:opendocument:xmlns:style:1.0"><office:styles><style:style xmlns:p="urn:wrong" x:name="spoof-x" p:name="spoof-p" style:name="Actual" x:family="wrong" style:family="paragraph"/></office:styles></office:document-styles>`,
      ctx,
    );
    expect(styles.get('Actual')).toEqual({ name: 'Actual', family: 'paragraph' });
    expect(styles.has('spoof')).toBe(false);
  });

  it('does not apply paragraph properties from a duplicate style definition', () => {
    const ctx = context();
    const styles = parseOdfStyles(
      `<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"><office:styles><style:style style:name="Repeated" style:family="paragraph"/><style:style style:name="Repeated" style:family="paragraph"><style:paragraph-properties style:default-outline-level="4"/></style:style></office:styles></office:document-styles>`,
      ctx,
    );
    expect(styles.get('Repeated')).toEqual({ name: 'Repeated', family: 'paragraph' });
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });

  it('ignores style definitions nested under extension wrappers', () => {
    const ctx = context();
    const styles = parseOdfStyles(
      `<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:ext="urn:example:extension"><office:styles><ext:wrapper><style:style style:name="nested" style:family="paragraph"/></ext:wrapper><style:style style:name="direct" style:family="paragraph"/></office:styles></office:document-styles>`,
      ctx,
    );
    expect([...styles.keys()]).toEqual(['direct']);
  });
});

describe('ODF manifest helpers', () => {
  it('returns safe path/media pairs and reports encryption data without decrypting', () => {
    const ctx = context();
    const result = parseOdfManifest(
      `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"><manifest:encryption-data/></manifest:file-entry><manifest:file-entry manifest:full-path="Pictures/a.png" manifest:media-type="image/png"/></manifest:manifest>`,
      ctx,
    );
    expect([...result.entries]).toEqual([
      ['content.xml', { mediaType: 'text/xml', encrypted: true }],
      ['Pictures/a.png', { mediaType: 'image/png', encrypted: false }],
    ]);
    expect(result.hasEncryptedEntries).toBe(true);
    expect(ctx.warnings.warnings).toEqual([]);
  });

  it('requires manifest root and only accepts direct file-entry children', () => {
    const ctx = context();
    const result = parseOdfManifest(
      `<wrapper xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="fake.xml" manifest:media-type="text/xml"/></wrapper>`,
      ctx,
    );
    expect(result.entries.size).toBe(0);
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });

  it('ignores nested manifest file-entry elements under extension wrappers', () => {
    const ctx = context();
    const result = parseOdfManifest(
      `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" xmlns:ext="urn:example:extension"><ext:wrapper><manifest:file-entry manifest:full-path="nested.xml" manifest:media-type="text/xml"/></ext:wrapper><manifest:file-entry manifest:full-path="direct.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
      ctx,
    );
    expect([...result.entries.keys()]).toEqual(['direct.xml']);
  });

  it('drops traversal, absolute and URL-like paths and rejects namespace spoofing', () => {
    const ctx = context();
    const result = parseOdfManifest(
      `<m:manifest xmlns:m="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" xmlns:x="urn:wrong"><m:file-entry m:full-path="../secret" m:media-type="text/plain"/><m:file-entry m:full-path="/etc/passwd" m:media-type="text/plain"/><m:file-entry m:full-path="https://example.invalid/file" m:media-type="text/plain"/><x:file-entry x:full-path="ok" x:media-type="text/plain"/></m:manifest>`,
      ctx,
    );
    expect(result.entries.size).toBe(0);
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual([
      'UNREADABLE_PART',
      'UNREADABLE_PART',
      'UNREADABLE_PART',
    ]);
  });

  it('keeps manifest keys literal and rejects encoded path separators and dot segments', () => {
    const ctx = context();
    const result = parseOdfManifest(
      `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="folder%20name/content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="Pictures%2f..%2fsecret" manifest:media-type="text/plain"/><manifest:file-entry manifest:full-path="Pictures%5C..%5Csecret" manifest:media-type="text/plain"/><manifest:file-entry manifest:full-path="%2E%2E/secret" manifest:media-type="text/plain"/></manifest:manifest>`,
      ctx,
    );
    expect([...result.entries]).toEqual([
      ['folder%20name/content.xml', { mediaType: 'text/xml', encrypted: false }],
    ]);
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual([
      'UNREADABLE_PART',
      'UNREADABLE_PART',
      'UNREADABLE_PART',
    ]);
  });

  it('uses first duplicate path deterministically, warns structurally and honors strict/abort', () => {
    const ctx = context();
    const xml = `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="a" manifest:media-type="text/plain"/><manifest:file-entry manifest:full-path="a" manifest:media-type="image/png"/></manifest:manifest>`;
    expect(parseOdfManifest(xml, ctx).entries.get('a')?.mediaType).toBe('text/plain');
    expect(ctx.warnings.warnings.map(({ message }) => message)).toEqual([
      'ODF manifest contains a duplicate part path.',
    ]);

    expect(() => parseOdfManifest(xml, context({ strict: ['UNREADABLE_PART'] }))).toThrow(/strict mode/i);
    const controller = new AbortController();
    controller.abort();
    expect(() => parseOdfManifest(xml, context({ signal: controller.signal }))).toThrow(/aborted/i);
  });
});
