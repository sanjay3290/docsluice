import { writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hand-made archive (CC0-1.0): a CSV, an HTML page, a nested zip holding a text file, a PNG, and a
// directory entry, in this central-directory order.
const mtime = new Date('1980-01-01T00:00:00Z');
const png = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
);
const nested = zipSync({ 'notes.txt': [strToU8('Tide notes from the nested archive.\n'), { mtime }] }, { level: 9 });
const entries = Object.create(null);
entries['data/'] = [new Uint8Array(0), { mtime }];
entries['data/readings.csv'] = [strToU8('site,ph\nNorth,7.1\nSouth,6.9\n'), { mtime }];
entries['page.html'] = [strToU8('<!doctype html><html><head><title>Bundle page</title></head><body><h1>Survey</h1><p>Read me.</p></body></html>'), { mtime }];
entries['inner.zip'] = [nested, { mtime, level: 0 }];
entries['pixel.png'] = [png, { mtime, level: 0 }];
await writeFile(new URL('../../corpus/zip/bundle.zip', import.meta.url), zipSync(entries, { level: 9 }));
await writeFile(
  new URL('../../corpus/zip/bundle.zip.license', import.meta.url),
  'SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-zip-bundle.mjs\nRequirements: NST-1, NST-3, NST-4\nNotes: a directory entry, a CSV, an HTML page, a nested zip with a text file, and a 1x1 PNG.\n',
);
