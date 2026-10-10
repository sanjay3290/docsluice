import { TextEncoder } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { TAR_END, concat, gzipMember, paxEntry, tarEntry, tarHeader } from '../corpus/archive-writer.mjs';

// Hostile GZIP and TAR inputs: a gzip bomb, nested gzip, trailer lies, tar size lies, a pax header
// bomb, a bad checksum and path tricks.
const encoder = new TextEncoder();
const gzip = new URL('../../hostile/gzip/', import.meta.url);
const tar = new URL('../../hostile/tar/', import.meta.url);
await mkdir(gzip, { recursive: true });
await mkdir(tar, { recursive: true });

// 200 MB of zeros in about 200 KB: the compression-ratio limit stops it.
await writeFile(new URL('bomb-200mb.gz', gzip), gzipMember(new Uint8Array(200 * 1024 * 1024)));

// GZIP inside GZIP, five levels: children share one budget, and the child depth limit stops it.
let nested = gzipMember(encoder.encode('innermost\n'), { name: 'level0.txt' });
for (let level = 1; level <= 5; level++) nested = gzipMember(nested, { name: `level${level}.gz` });
await writeFile(new URL('nested-5.gz', gzip), nested);

// A member whose trailer claims the wrong CRC and size.
const member = gzipMember(encoder.encode('trailer lies\n'));
member.set([0xde, 0xad, 0xbe, 0xef, 0xff, 0xff, 0xff, 0x7f], member.length - 8);
await writeFile(new URL('trailer-lie.gz', gzip), member);

// A header whose FEXTRA length runs past the end of the file.
await writeFile(new URL('extra-overrun.gz', gzip), Uint8Array.of(0x1f, 0x8b, 8, 0x04, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 1, 2));

// A file header that claims 8 GiB of data in a small archive.
await writeFile(new URL('size-lie.tar', tar), concat([tarHeader('big.bin', { size: 8 * 1024 ** 3 }), new Uint8Array(512), TAR_END]));

// A pax header that claims a 1 PB size for the next entry.
await writeFile(
  new URL('pax-size-lie.tar', tar),
  concat([paxEntry([['size', '1125899906842624']]), tarEntry('small.txt', encoder.encode('small\n')), TAR_END]),
);

// A pax header bomb: 10,000 records in one header, then 200 chained headers before one file.
const records = Array.from({ length: 10_000 }, (_, index) => [`comment.${index}`, 'x'.repeat(16)]);
const chain = Array.from({ length: 200 }, (_, index) => paxEntry([['path', `chain/${index}.txt`]]));
await writeFile(
  new URL('pax-header-bomb.tar', tar),
  concat([paxEntry(records), ...chain, tarEntry('final.txt', encoder.encode('after the pax headers\n')), TAR_END]),
);

// A header with a wrong checksum.
await writeFile(
  new URL('bad-checksum.tar', tar),
  concat([tarHeader('file.txt', { size: 0, checksum: 1 }), TAR_END]),
);

// The entry limit (10,000 by default) needs at least 5 MB of headers; the unit tests cover it with a low limit.

// Names that try to leave the archive: kept as plain relative names, never written anywhere.
await writeFile(
  new URL('path-tricks.tar', tar),
  concat([
    tarEntry('../../etc/passwd', encoder.encode('a\n')),
    tarEntry('/absolute/file.txt', encoder.encode('b\n')),
    tarEntry('C:\\windows\\file.txt', encoder.encode('c\n')),
    tarEntry('escape', undefined, { type: '2', linkName: '../../../etc/shadow' }),
    tarEntry('device', undefined, { type: '3' }),
    TAR_END,
  ]),
);
