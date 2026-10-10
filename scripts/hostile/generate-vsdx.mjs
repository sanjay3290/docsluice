import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, unzipSync, zipSync } from 'fflate';

// Hostile VSDX packages built from the synthetic corpus package: shapes nested 1,000 deep, and
// 20,000 sibling shapes that reuse one ID.
const directory = new URL('../../hostile/vsdx/', import.meta.url);
await mkdir(directory, { recursive: true });
const base = unzipSync(new Uint8Array(await readFile(new URL('../../corpus/vsdx/tiny-flow.vsdx', import.meta.url))));
const CORE = 'http://schemas.microsoft.com/office/visio/2011/1/core';
const page = (shapes) =>
  `<?xml version="1.0" encoding="UTF-8"?><PageContents xmlns="${CORE}"><Shapes>${shapes}</Shapes></PageContents>`;
function write(name, page1) {
  const entries = Object.create(null);
  for (const [path, bytes] of Object.entries(base)) entries[path] = [bytes, { mtime: new Date('1980-01-01T00:00:00Z') }];
  entries['visio/pages/page1.xml'] = [strToU8(page1), { mtime: new Date('1980-01-01T00:00:00Z') }];
  return writeFile(new URL(name, directory), zipSync(entries, { level: 9 }));
}
let nested = '<Shape ID="4"><Text>deep</Text></Shape>';
for (let depth = 0; depth < 1000; depth++) nested = `<Shape ID="4"><Shapes>${nested}</Shapes></Shape>`;
await write('nested-shapes-1000.vsdx', page(nested));
await write('duplicate-ids-20000.vsdx', page('<Shape ID="7"><Text>same</Text></Shape>'.repeat(20_000)));
