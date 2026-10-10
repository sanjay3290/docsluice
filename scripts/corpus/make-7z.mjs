import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

// 7z corpus archives (CC0-1.0), made with the 7-Zip command line (`7z`, for example from
// p7zip-full or 7-Zip 23.01) from synthetic files: the default LZMA-encoded header, a stored
// header, encrypted contents, an encrypted header, and 300 similar names. Usage: node scripts/corpus/make-7z.mjs [7z]
const sevenZip = process.argv[2] ?? '7z';
const output = fileURLToPath(new URL('../../corpus/7z/', import.meta.url));
await mkdir(output, { recursive: true });
const work = await mkdtemp(path.join(tmpdir(), 'docsluice-7z-'));
try {
  const source = path.join(work, 'src');
  await mkdir(path.join(source, 'docs', 'empty-dir'), { recursive: true });
  const files = [
    ['docs/hello.txt', 'Hello from a 7z archive.\n'],
    ['data.csv', 'a,b\n1,2\n'],
    ['docs/empty.txt', ''],
    ['docs/ünïcode é.txt', 'Non-ASCII name.\n'],
  ];
  for (const [name, text] of files) await writeFile(path.join(source, name), text);
  // 300 similar names: a header whose LZMA stream uses matches and repeated distances.
  await mkdir(path.join(source, 'logs'));
  for (let index = 0; index < 300; index++) {
    const name = `logs/station-${String(index).padStart(3, '0')}-reading.log`;
    files.push([name, `reading ${index}\n`]);
    await writeFile(path.join(source, name), `reading ${index}\n`);
  }
  const time = new Date('2026-01-01T00:00:00Z');
  for (const name of ['docs/empty-dir', 'docs', 'logs', ...files.map(([name]) => name)])
    await utimes(path.join(source, name), time, time);
  const main = ['docs', 'data.csv'];
  const variants = [
    ['listing.7z', [], main],
    ['listing-stored-header.7z', ['-mhc=off'], main],
    ['encrypted-content.7z', ['-pdocsluice'], main],
    ['encrypted-header.7z', ['-pdocsluice', '-mhe=on'], main],
    ['many-files.7z', [], ['logs']],
  ];
  for (const [name, flags, inputs] of variants) {
    const target = path.join(output, name);
    await rm(target, { force: true });
    const result = spawnSync(sevenZip, ['a', '-bd', '-bso0', ...flags, target, ...inputs], { cwd: source });
    if (result.status !== 0) throw new Error(`${sevenZip} failed for ${name}`);
    await writeFile(
      `${target}.license`,
      `SPDX-License-Identifier: CC0-1.0\nSource: made for docsluice with the 7-Zip command line by scripts/corpus/make-7z.mjs (${flags.join(' ') || 'default options'})\nRequirements: IN-4\nNotes: listing only (ADR 0014); synthetic files, a directory, an empty directory and file, and a non-ASCII name.\n`,
    );
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
