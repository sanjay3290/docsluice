import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Budget } from '../../src/core/budget.js';
import { EncryptedError, StrictModeError } from '../../src/core/errors.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { WarningSink } from '../../src/core/warnings.js';
import type { XmlContext } from '../../src/xml/index.js';
import { makeZip } from '../helpers/zip.js';
import { openZip } from '../../src/zip/index.js';
import { openCfb } from '../../src/ole/index.js';
import { OoxmlParts } from '../../src/ooxml/parts.js';
import { readRelationships, resolveInternalTarget } from '../../src/ooxml/rels.js';
import { readContentTypes } from '../../src/ooxml/content-types.js';
import { readProperties } from '../../src/ooxml/props.js';
import { scanFeatures, rejectEncryptedOffice } from '../../src/ooxml/features.js';
import { fuzzOoxml } from '../../fuzz/ooxml.fuzz.js';

const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const FREE = 0xffff_ffff;
const END = 0xffff_fffe;
const FAT = 0xffff_fffd;

function makeEncryptedCfb(nested = false): Uint8Array {
  const bytes = new Uint8Array(512 * 4);
  const header = new DataView(bytes.buffer);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  header.setUint16(24, 0x003e, true);
  header.setUint16(26, 3, true);
  header.setUint16(28, 0xfffe, true);
  header.setUint16(30, 9, true);
  header.setUint16(32, 6, true);
  header.setUint32(44, 1, true);
  header.setUint32(48, 1, true);
  header.setUint32(56, 4096, true);
  header.setUint32(60, END, true);
  header.setUint32(68, END, true);
  for (let index = 0; index < 109; index += 1) header.setUint32(76 + index * 4, index === 0 ? 0 : FREE, true);
  const fat = new DataView(bytes.buffer, 512, 512);
  for (let index = 0; index < 128; index += 1) fat.setUint32(index * 4, FREE, true);
  fat.setUint32(0, FAT, true);
  fat.setUint32(4, END, true);
  fat.setUint32(8, END, true);
  const directory = new DataView(bytes.buffer, 1024, 512);
  const write = (slot: number, name: string, type: number, child: number, start: number, size: number) => {
    const base = slot * 128;
    for (let index = 0; index < name.length; index += 1)
      directory.setUint16(base + index * 2, name.charCodeAt(index), true);
    directory.setUint16(base + name.length * 2, 0, true);
    directory.setUint16(base + 64, (name.length + 1) * 2, true);
    directory.setUint8(base + 66, type);
    directory.setUint8(base + 67, 1);
    directory.setUint32(base + 68, FREE, true);
    directory.setUint32(base + 72, FREE, true);
    directory.setUint32(base + 76, child, true);
    directory.setUint32(base + 116, start, true);
    directory.setBigUint64(base + 120, BigInt(size), true);
  };
  write(0, 'Root Entry', 5, 1, END, 0);
  if (nested) {
    write(1, 'Folder', 1, 2, END, 0);
    write(2, 'EncryptedPackage', 2, FREE, 2, 4096);
  } else write(1, 'EncryptedPackage', 2, FREE, 2, 4096);
  bytes[1536] = 0x58;
  return bytes;
}

function context(options: { strict?: boolean; xmlDepth?: number; signal?: AbortSignal } = {}) {
  const warnings = new WarningSink({ strict: options.strict });
  const budget = new Budget(
    { ...DEFAULT_LIMITS, ...(options.xmlDepth === undefined ? {} : { xmlDepth: options.xmlDepth }) },
    { warnings, ...(options.signal ? { signal: options.signal } : {}) },
  );
  return { budget, warnings, ctx: { budget, warnings } satisfies XmlContext };
}

function createParts(files: Array<{ name: string; data: string }>, ctx = context()) {
  const archive = openZip(
    makeZip(files.map((file) => ({ name: file.name, data: new TextEncoder().encode(file.data) }))),
    ctx.budget,
  );
  return { archive, parts: new OoxmlParts(archive, ctx.ctx), ...ctx };
}

describe('OOXML shared helpers', () => {
  it('interprets timezone-free property dates as UTC across host timezones', async () => {
    const { parts, ctx } = createParts([
      {
        name: 'docProps/core.xml',
        data: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/"><dcterms:created>2024-02-03T04:05:06</dcterms:created></cp:coreProperties>',
      },
    ]);
    expect((await readProperties(parts, ctx)).created).toBe('2024-02-03T04:05:06.000Z');
  });
  it('resolves exact names first and refuses ambiguous case-fold matches', async () => {
    const { archive, parts, warnings } = createParts([
      { name: 'Word/Document.xml', data: 'exact' },
      { name: 'word/document.XML', data: 'first' },
      { name: 'WORD/DOCUMENT.xml', data: 'second' },
    ]);
    expect(parts.find('Word/Document.xml')?.name).toBe('Word/Document.xml');
    expect(parts.find('word/document.xml')).toBeUndefined();
    expect(warnings.warnings.map((warning) => warning.code)).toContain('UNREADABLE_PART');
    expect(await parts.read('Word/Document.xml')).toEqual(new TextEncoder().encode('exact'));
    expect(archive.entries).toHaveLength(3);
  });

  it('warns deterministically for duplicate exact names and treats missing parts as absent', () => {
    const { parts, warnings } = createParts([
      { name: 'docProps/core.xml', data: '<a/>' },
      { name: 'docProps/core.xml', data: '<b/>' },
    ]);
    expect(parts.find('docProps/core.xml')).toBeUndefined();
    expect(parts.find('missing.xml')).toBeUndefined();
    expect(warnings.warnings.map((warning) => warning.code)).toEqual(['UNREADABLE_PART']);
  });

  it('reports an archive entry marked unreadable without trying to parse its bytes', async () => {
    const ctx = context();
    const entry = {
      name: '_rels/.rels',
      compressedSize: 0,
      uncompressedSize: 0,
      compressionMethod: 0,
      isEncrypted: false,
      isUnreadable: true,
    };
    const packageParts = new OoxmlParts({ entries: [entry], read: () => Promise.resolve(null) }, ctx.ctx);
    expect(await readRelationships(packageParts, '', ctx.ctx)).toEqual(new Map());
    expect(ctx.warnings.warnings.map((warning) => warning.code)).toContain('UNREADABLE_PART');
  });

  it('returns the same ambiguous fallback result when archive entry order changes', () => {
    const names = ['word/Document.xml', 'WORD/DOCUMENT.XML'];
    const forward = createParts(names.map((name) => ({ name, data: 'x' })));
    const reverse = createParts([...names].reverse().map((name) => ({ name, data: 'x' })));
    expect(forward.parts.find('Word/document.xml')).toBeUndefined();
    expect(reverse.parts.find('Word/document.xml')).toBeUndefined();
  });

  it('parses exact relationship namespace and resolves safe relative, root-absolute and external targets', async () => {
    const doc = `<Relationships xmlns="${RELS}">
      <Relationship Id="r1" Type="image" Target="../media/x.png"/>
      <Relationship Id="r2" Type="slide" Target="/word/x.xml"/>
      <Relationship Id="r3" Type="hyperlink" Target="https://example.invalid/a" TargetMode="External"/>
      <x:Relationship xmlns:x="urn:spoof" Id="evil" Type="x" Target="../../outside"/>
    </Relationships>`;
    const env = createParts([{ name: 'word/_rels/document.xml.rels', data: doc }]);
    const rels = await readRelationships(env.parts, 'word/document.xml', env.ctx);
    expect(rels.get('r1')).toMatchObject({ part: 'media/x.png', external: false });
    expect(rels.get('r2')).toMatchObject({ part: 'word/x.xml', external: false });
    expect(rels.get('r3')).toMatchObject({ target: 'https://example.invalid/a', external: true });
    expect(rels.get('r3')?.part).toBeUndefined();
    expect(rels.has('evil')).toBe(false);
  });

  it('validates canonical source paths and prevents package-root traversal', () => {
    expect(resolveInternalTarget('document.xml', '../x.xml')).toBeUndefined();
    expect(resolveInternalTarget('../../doc.xml', 'target.xml')).toBeUndefined();
    expect(resolveInternalTarget('word/document.xml', '../media/x.png')).toBe('media/x.png');
  });

  it('ignores relationship records nested under extension elements', async () => {
    const xml = `<Relationships xmlns="${RELS}"><Extension><Relationship Id="nested" Type="external" Target="https://outside.invalid" TargetMode="External"/></Extension><Relationship Id="direct" Type="part" Target="document.xml"/></Relationships>`;
    const env = createParts([{ name: '_rels/.rels', data: xml }]);
    const rels = await readRelationships(env.parts, '', env.ctx);
    expect(rels.has('nested')).toBe(false);
    expect(rels.has('direct')).toBe(true);
  });

  it.each(['../../../escape', 'https://outside.invalid/x', 'a%2fb.xml', 'bad%zz.xml'])(
    'rejects invalid internal relationship target %s',
    async (target) => {
      const xml = `<Relationships xmlns="${RELS}"><Relationship Id="r" Type="x" Target="${target}"/></Relationships>`;
      const env = createParts([{ name: '_rels/.rels', data: xml }]);
      expect((await readRelationships(env.parts, '', env.ctx)).has('r')).toBe(false);
      expect(env.warnings.warnings.map((warning) => warning.code)).toContain('UNREADABLE_PART');
    },
  );

  it('fails duplicate relationship ids independent of ZIP order', async () => {
    const xml = `<Relationships xmlns="${RELS}"><Relationship Id="same" Type="a" Target="a.xml"/><Relationship Id="same" Type="b" Target="b.xml"/></Relationships>`;
    const a = createParts([{ name: '_rels/.rels', data: xml }]);
    const b = createParts([{ name: '_rels/.rels', data: xml }]);
    expect([...(await readRelationships(a.parts, '', a.ctx)).keys()]).toEqual([]);
    expect([...(await readRelationships(b.parts, '', b.ctx)).keys()]).toEqual([]);
    expect(a.warnings.warnings.map((warning) => warning.code)).toEqual(['UNREADABLE_PART']);
  });

  it('reads namespaced content types and applies defaults and overrides', async () => {
    const xml = `<Types xmlns="${TYPES}"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/doc"/></Types>`;
    const env = createParts([{ name: '[Content_Types].xml', data: xml }]);
    const table = await readContentTypes(env.parts, env.ctx);
    expect(table.mimeType('word/document.xml')).toBe('application/doc');
    expect(table.mimeType('word/styles.xml')).toBe('application/xml');
  });

  it('rejects duplicate content type keys, including a third repeated key', async () => {
    const xml = `<Types xmlns="${TYPES}"><Default Extension="xml" ContentType="a"/><Default Extension="XML" ContentType="b"/><Default Extension="xml" ContentType="c"/></Types>`;
    const env = createParts([{ name: '[Content_Types].xml', data: xml }]);
    const table = await readContentTypes(env.parts, env.ctx);
    expect(table.mimeType('part.xml')).toBeUndefined();
    expect(env.warnings.warnings.map((warning) => warning.code)).toContain('UNREADABLE_PART');
  });

  it('ignores content type records nested under extension elements', async () => {
    const xml = `<Types xmlns="${TYPES}"><Extension><Default Extension="xml" ContentType="application/nested"/></Extension><Default Extension="txt" ContentType="text/plain"/></Types>`;
    const env = createParts([{ name: '[Content_Types].xml', data: xml }]);
    const types = await readContentTypes(env.parts, env.ctx);
    expect(types.mimeType('part.xml')).toBeUndefined();
    expect(types.mimeType('part.txt')).toBe('text/plain');
  });

  it('omits every custom property with a duplicated name and warns on bad property roots', async () => {
    const xml =
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property name="same"><vt:lpwstr>a</vt:lpwstr></property><property name="same"><vt:lpwstr>b</vt:lpwstr></property><property name="same"><vt:lpwstr>c</vt:lpwstr></property></Properties>';
    const env = createParts([
      { name: 'docProps/custom.xml', data: xml },
      { name: 'docProps/core.xml', data: '<evil/>' },
    ]);
    const metadata = await readProperties(env.parts, env.ctx);
    expect(metadata.custom).toBeUndefined();
    expect(env.warnings.warnings.map((warning) => warning.code)).toContain('UNREADABLE_PART');
  });

  it('skips invalid dates and counts while reporting structural warnings', async () => {
    const env = createParts([
      {
        name: 'docProps/core.xml',
        data: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/"><dcterms:created>2025-02-31</dcterms:created></cp:coreProperties>',
      },
      {
        name: 'docProps/app.xml',
        data: '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>999999999999999999999</Pages></Properties>',
      },
    ]);
    const metadata = await readProperties(env.parts, env.ctx);
    expect(metadata.created).toBeUndefined();
    expect(metadata.pageCount).toBeUndefined();
    expect(env.warnings.warnings.map((warning) => warning.code)).toContain('UNREADABLE_PART');
  });

  it('reads LibreOffice-written properties, omitting the empty creator and title', async () => {
    for (const name of [
      'docx/headings-outline.docx',
      'xlsx/workbook-values-formulas.xlsx',
      'pptx/deck-slide-order.pptx',
    ]) {
      const ctx = context();
      const archive = openZip(
        new Uint8Array(readFileSync(new URL(`../../../../corpus/${name}`, import.meta.url))),
        ctx.budget,
      );
      const parts = new OoxmlParts(archive, ctx);
      const properties = await readProperties(parts, ctx);
      expect(properties.language).toBe('en-US');
      expect(properties).not.toHaveProperty('title');
      expect(properties).not.toHaveProperty('authors');
      expect(ctx.warnings.warnings).toEqual([]);
    }
  });

  it('maps core, app and custom properties while metadata false omits personal data', async () => {
    const env = createParts([
      {
        name: 'docProps/core.xml',
        data: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>Report</dc:title><dc:creator>Ada</dc:creator><cp:lastModifiedBy>Lin</cp:lastModifiedBy><dcterms:created>2025-01-02T03:04:05Z</dcterms:created><dcterms:modified>2025-01-03T03:04:05Z</dcterms:modified></cp:coreProperties>',
      },
      {
        name: 'docProps/app.xml',
        data: '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>12</Pages><Slides>8</Slides></Properties>',
      },
      {
        name: 'docProps/custom.xml',
        data: '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property name="Project"><vt:lpwstr>North</vt:lpwstr></property><property name="__proto__"><vt:lpwstr>safe</vt:lpwstr></property><property name="Labels"><vt:vector size="2" baseType="lpwstr"><vt:lpwstr>North</vt:lpwstr><vt:lpwstr>East</vt:lpwstr></vt:vector></property><property name="Variant"><vt:vector size="1" baseType="variant"><vt:variant><vt:lpwstr>item</vt:lpwstr></vt:variant></vt:vector></property></Properties>',
      },
    ]);
    expect(await readProperties(env.parts, env.ctx)).toEqual({
      title: 'Report',
      authors: ['Ada', 'Lin'],
      created: '2025-01-02T03:04:05.000Z',
      modified: '2025-01-03T03:04:05.000Z',
      pageCount: 12,
      custom: [
        { name: 'Project', value: 'North' },
        { name: '__proto__', value: 'safe' },
        { name: 'Labels', value: 'North, East' },
        { name: 'Variant', value: 'item' },
      ],
    });
    expect(await readProperties(env.parts, env.ctx, false)).toMatchObject({ title: 'Report', pageCount: 12 });
    expect(await readProperties(env.parts, env.ctx, false)).not.toHaveProperty('authors');
    expect(await readProperties(env.parts, env.ctx, false)).not.toHaveProperty('custom');
  });

  it('ignores forged metadata records in extensions and rejects nested scalar markup', async () => {
    const env = createParts([
      {
        name: 'docProps/core.xml',
        data: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:ext="urn:extension"><dc:title>Root title</dc:title><ext:Extension><dc:title>Forged title</dc:title><dc:creator>Forged author</dc:creator></ext:Extension><dc:language>en<ext:payload>forged</ext:payload></dc:language></cp:coreProperties>',
      },
      {
        name: 'docProps/app.xml',
        data: '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:ext="urn:extension"><Pages>2</Pages><ext:Extension><Pages>999</Pages></ext:Extension></Properties>',
      },
      {
        name: 'docProps/custom.xml',
        data: '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes" xmlns:ext="urn:extension"><property name="safe"><vt:lpwstr>kept</vt:lpwstr></property><ext:Extension><property name="forged"><vt:lpwstr>ignored</vt:lpwstr></property></ext:Extension><property name="nested"><vt:lpwstr>part<ext:payload>forged</ext:payload></vt:lpwstr></property><property name="unsupported"><vt:array lBound="0" uBound="1"><vt:lpwstr>forged</vt:lpwstr></vt:array></property></Properties>',
      },
    ]);
    const metadata = await readProperties(env.parts, env.ctx);
    expect(metadata.title).toBe('Root title');
    expect(metadata.authors).toBeUndefined();
    expect(metadata.language).toBeUndefined();
    expect(metadata.pageCount).toBe(2);
    expect(metadata.custom).toEqual([{ name: 'safe', value: 'kept' }]);
    expect(env.warnings.warnings.map((warning) => warning.code)).toContain('UNREADABLE_PART');
  });

  it('sets macro, external-link and embedded-file features and warns once for macros', async () => {
    const xml = `<Relationships xmlns="${RELS}"><Relationship Id="external" Type="link" Target="https://example.invalid" TargetMode="External"/></Relationships>`;
    const env = createParts([
      { name: 'xl/vbaProject.bin', data: 'x' },
      { name: 'word/embeddings/oleObject1.bin', data: 'x' },
      { name: 'word/_rels/document.xml.rels', data: xml },
    ]);
    expect(await scanFeatures(env.parts, env.archive, env.ctx)).toMatchObject({
      hasMacros: true,
      hasExternalLinks: true,
      hasEmbeddedFiles: true,
    });
    expect(env.warnings.warnings.filter((warning) => warning.code === 'MACROS_PRESENT')).toHaveLength(1);
  });

  it('scans relationship files for package-root parts', async () => {
    const xml = `<Relationships xmlns="${RELS}"><Relationship Id="external" Type="link" Target="https://example.invalid" TargetMode="External"/></Relationships>`;
    const env = createParts([{ name: '_rels/custom.xml.rels', data: xml }]);
    expect((await scanFeatures(env.parts, env.archive, env.ctx)).hasExternalLinks).toBe(true);
  });

  it('keeps nested extension records inert in the standalone hostile package', async () => {
    const ctx = context();
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../../hostile/ooxml/extension-nested-records.zip', import.meta.url)),
    );
    const archive = openZip(bytes, ctx.budget);
    const packageParts = new OoxmlParts(archive, ctx.ctx);
    const relationships = await readRelationships(packageParts, 'word/document.xml', ctx.ctx);
    const contentTypes = await readContentTypes(packageParts, ctx.ctx);
    const features = await scanFeatures(packageParts, archive, ctx.ctx);
    expect(relationships.has('nested-external')).toBe(false);
    expect(contentTypes.mimeType('sample.bad')).toBeUndefined();
    expect(features.hasExternalLinks).toBe(false);
  });

  it('throws EncryptedError when the CFB root has EncryptedPackage', () => {
    const ctx = context();
    expect(() => rejectEncryptedOffice(openCfb(makeEncryptedCfb(), ctx.budget), ctx.budget)).toThrow(
      EncryptedError,
    );
  });

  it('does not treat a nested EncryptedPackage stream as the root encryption marker', () => {
    const ctx = context();
    expect(() =>
      rejectEncryptedOffice(openCfb(makeEncryptedCfb(true), ctx.budget), ctx.budget),
    ).not.toThrow();
  });

  it('ignores DTD entities while continuing to parse safe relationship structure', async () => {
    const xml = `<!DOCTYPE Relationships [<!ENTITY hostile "expanded">]><Relationships xmlns="${RELS}"><Relationship Id="r" Type="x" Target="safe.xml">&hostile;</Relationship></Relationships>`;
    const env = createParts([{ name: '_rels/.rels', data: xml }]);
    expect((await readRelationships(env.parts, '', env.ctx)).get('r')?.part).toBe('safe.xml');
    expect(env.warnings.warnings.map((warning) => warning.code)).toContain('DTD_IGNORED');
  });

  it('propagates strict warnings, XML depth, and cancellation', async () => {
    const malformed = createParts(
      [{ name: '_rels/.rels', data: '<Relationships xmlns="urn:wrong"/>' }],
      context({ strict: true }),
    );
    await expect(readRelationships(malformed.parts, '', malformed.ctx)).rejects.toBeInstanceOf(
      StrictModeError,
    );
    const deep = createParts(
      [{ name: '_rels/.rels', data: `<Relationships xmlns="${RELS}"><x><y/></x></Relationships>` }],
      context({ xmlDepth: 1 }),
    );
    await readRelationships(deep.parts, '', deep.ctx);
    expect(deep.warnings.warnings.map((warning) => warning.code)).toContain('TRUNCATED');
    const controller = new AbortController();
    const aborted = createParts(
      [{ name: '_rels/.rels', data: `<Relationships xmlns="${RELS}"/>` }],
      context({ signal: controller.signal }),
    );
    controller.abort();
    await expect(readRelationships(aborted.parts, '', aborted.ctx)).rejects.toThrow();
  });
});

describe('OOXML fuzz entry point', () => {
  it('survives seeded corruptions of a real package', async () => {
    const source = new Uint8Array(
      readFileSync(new URL('../../../../corpus/docx/lists-tables.docx', import.meta.url)),
    );
    for (let seed = 1; seed <= 200; seed++) {
      const bytes = source.slice();
      let state = seed;
      for (let flip = 0; flip < 8; flip++) {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        const at = state % bytes.length;
        bytes[at] = bytes[at]! ^ (1 + (state % 255));
      }
      await expect(fuzzOoxml(bytes)).resolves.toBeUndefined();
    }
    await expect(fuzzOoxml(source)).resolves.toBeUndefined();
  });
});
