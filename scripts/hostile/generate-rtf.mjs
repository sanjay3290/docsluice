import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Hostile RTF inputs: deep group nesting, \bin length lies, unterminated groups, picture and table floods.
const rtf = new URL('../../hostile/rtf/', import.meta.url);
await mkdir(rtf, { recursive: true });

await writeFile(
  new URL('nested-groups-100000.rtf', rtf),
  `{\\rtf1 before ${'{'.repeat(100_000)}deep${'}'.repeat(100_000)} after\\par}`,
);

// \bin claims far more bytes than the file holds, inside and outside a picture.
await writeFile(
  new URL('bin-length-lies.rtf', rtf),
  '{\\rtf1 start {\\*\\shppict{\\pict\\pngblip\\bin4294967295 ABCD}} middle \\bin99999999999999999999 tail}',
);

await writeFile(new URL('unterminated-groups.rtf', rtf), `{\\rtf1 opened ${'{\\b x '.repeat(20_000)}`);

// 2 MB of picture hex digits charged to the uncompressed allowance, plus a flood of empty cells.
await writeFile(
  new URL('picture-and-cell-flood.rtf', rtf),
  `{\\rtf1{\\pict\\pngblip ${'0'.repeat(2_000_000)}}\\trowd${'\\cellx1'.repeat(20_000)}${'\\cell'.repeat(20_000)}\\row}`,
);

// Control words with huge numbers and names, and a \uc that would skip everything.
await writeFile(
  new URL('control-word-abuse.rtf', rtf),
  `{\\rtf1\\uc999999999 \\u-99999999999? ${'\\' + 'a'.repeat(100_000)} \\ansicpg99999999999999 \\'zz text\\par}`,
);
