import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { TextEncoder } from 'node:util';
import { rar4, rar5 } from './rar-writer.mjs';

// Hand-made RAR 4 and RAR 5 archives (CC0-1.0) with stored entries: nested paths, a directory, an
// empty file and a non-ASCII name. `bsdtar -tvf` (libarchive) lists them the same way.
const directory = new URL('../../corpus/rar/', import.meta.url);
await mkdir(directory, { recursive: true });
const text = (value) => new TextEncoder().encode(value);
const entries = [
  { name: 'docs', directory: true },
  { name: 'docs/hello.txt', data: text('Hello from a RAR archive.\n') },
  { name: 'docs/empty.txt', data: new Uint8Array(0) },
  { name: 'data.csv', data: text('a,b\n1,2\n') },
  { name: 'docs/café.txt', data: text('Non-ASCII name.\n') },
];
const license = (format) =>
  `SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-rar.mjs (${format}, stored entries)\nRequirements: IN-4\nNotes: listing only (ADR 0014); a directory, nested paths, an empty file and a non-ASCII name.\n`;
await writeFile(new URL('listing-rar5.rar', directory), rar5(entries));
await writeFile(new URL('listing-rar5.rar.license', directory), license('RAR 5.0'));
await writeFile(new URL('listing-rar4.rar', directory), rar4(entries.filter((entry) => entry.name !== 'docs/café.txt')));
await writeFile(new URL('listing-rar4.rar.license', directory), license('RAR 4'));
