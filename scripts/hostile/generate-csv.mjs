import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Hostile CSV and TSV inputs: column floods, quote floods and prototype-named headers.
const csv = new URL('../../hostile/csv/', import.meta.url);
await mkdir(csv, { recursive: true });
await writeFile(new URL('wide-20000-columns.csv', csv), `a,b,c\n1,2,3\n${','.repeat(20_000)}\n`);
await writeFile(new URL('quote-flood-100k.csv', csv), `a,b,c\n1,2,3\n${'"'.repeat(100_001)}`);
await writeFile(new URL('proto-headers.csv', csv), '__proto__,constructor,prototype\n1,2,3\n');

const tsv = new URL('../../hostile/tsv/', import.meta.url);
await mkdir(tsv, { recursive: true });
await writeFile(new URL('ragged-5000-rows.tsv', tsv), `a\tb\tc\n1\t2\t3\n${Array.from({ length: 5_000 }, (_, row) => '\t'.repeat(row % 64)).join('x\n')}x\n`);
