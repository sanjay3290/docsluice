import { TextEncoder } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { TAR_END, concat, gzipMember, paxEntry, tarEntry } from './archive-writer.mjs';

// GZIP and TAR corpus files, built deterministically (mtime 0, fixed order). Run from the repository root.
const encoder = new TextEncoder();
const gzip = new URL('../../corpus/gzip/', import.meta.url);
const tar = new URL('../../corpus/tar/', import.meta.url);
await mkdir(gzip, { recursive: true });
await mkdir(tar, { recursive: true });

async function write(directory, name, bytes, notes) {
  await writeFile(new URL(name, directory), bytes);
  await writeFile(
    new URL(`${name}.license`, directory),
    `SPDX-License-Identifier: CC0-1.0\nSource: made for docsluice by scripts/corpus/make-archives.mjs\nNotes: ${notes}\n`,
  );
}

const csv = encoder.encode('species,count,site\nsea lavender,12,north\ncordgrass,30,south\n');
await write(gzip, 'scores.csv.gz', gzipMember(csv, { name: 'scores.csv' }), 'A CSV in one GZIP member with its original name.');
await write(
  gzip,
  'multi-member.txt.gz',
  concat([gzipMember(encoder.encode('first member line\n')), gzipMember(encoder.encode('second member line\n'))]),
  'Two concatenated GZIP members; the child is their joined text.',
);
await write(
  gzip,
  'optional-header.gz',
  gzipMember(encoder.encode('optional header fields\n'), {
    name: 'notes.txt',
    comment: 'header comment',
    extra: Uint8Array.of(0x41, 0x42, 2, 0, 1, 2),
    headerCrc: true,
  }),
  'FEXTRA, FNAME, FCOMMENT and FHCRC header fields.',
);

const nested = concat([
  tarEntry('field/', undefined, { type: '5', mode: 0o755 }),
  tarEntry('field/plots/', undefined, { type: '5', mode: 0o755 }),
  tarEntry('field/plots/counts.csv', csv),
  tarEntry('field/notes.md', encoder.encode('# Field notes\n\nPlot B was flooded.\n')),
  tarEntry('field/latest.csv', undefined, { type: '2', linkName: 'plots/counts.csv' }),
  TAR_END,
]);
await write(tar, 'nested-folders.tar', nested, 'ustar with nested folders, a CSV, Markdown and a symbolic link listed, never followed.');
await write(
  tar,
  'nested-folders.tar.gz',
  gzipMember(nested, { name: 'nested-folders.tar' }),
  'The nested-folders tar inside GZIP.',
);
const longPath = `${'deep/'.repeat(30)}readme.txt`;
await write(
  tar,
  'pax-long-path.tar',
  concat([paxEntry([['path', longPath]]), tarEntry('readme.txt', encoder.encode('reached through a pax path\n')), TAR_END]),
  'A pax extended header with a path longer than the ustar name field.',
);
const gnuName = `${'gnu-long-name-'.repeat(10)}.txt`;
await write(
  tar,
  'gnu-long-name.tar',
  concat([
    tarEntry('././@LongLink', encoder.encode(`${gnuName}\0`), { type: 'L' }),
    tarEntry(gnuName.slice(0, 99), encoder.encode('GNU long name body\n')),
    TAR_END,
  ]),
  'A GNU long-name (L) entry.',
);
