import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Hostile YAML, NDJSON, iCalendar, vCard, SubRip and WebVTT files: an alias bomb, nesting past every
// depth limit, a fold bomb, unbalanced components, tag soup and huge counts.
const root = new URL('../../hostile/', import.meta.url);
const files = new Map();

// Billion laughs: nine levels of ten aliases. docsluice never expands aliases, so it stays small.
let bomb = 'a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol","lol"]\n';
for (let level = 1; level < 9; level++) {
  const name = String.fromCharCode(97 + level);
  const previous = String.fromCharCode(96 + level);
  bomb += `${name}: &${name} [${new Array(10).fill(`*${previous}`).join(',')}]\n`;
}
files.set('yaml/alias-bomb.yaml', bomb);
files.set('yaml/deep-nesting.yaml', Array.from({ length: 1_000 }, (_, depth) => `${' '.repeat(depth)}k${depth}:`).join('\n') + '\n');
files.set('yaml/dash-chain.yaml', `${'- '.repeat(200_000)}x\n`);
files.set('yaml/block-scalar-flood.yaml', `text: |\n${'  line of a long block scalar\n'.repeat(30_000)}`);

files.set('ndjson/deep-records.ndjson', `${'['.repeat(5_000)}${']'.repeat(5_000)}\n`.repeat(20) + '{"ok":1}\n');
files.set('ndjson/many-records.ndjson', Array.from({ length: 30_000 }, (_, index) => `{"n":${index}}`).join('\n') + '\n');

files.set('ics/fold-bomb.ics', `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:start${'\r\n x'.repeat(200_000)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
files.set('ics/unbalanced-begin.ics', `BEGIN:VCALENDAR\r\n${'BEGIN:VEVENT\r\nSUMMARY:open\r\n'.repeat(5_000)}`);
files.set('ics/semicolon-params.ics', `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY${';X=1'.repeat(50_000)}:value\r\nDESCRIPTION:${'\\,'.repeat(50_000)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
files.set('vcf/many-cards.vcf', 'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Card\r\nN:;;;;\r\nEND:VCARD\r\n'.repeat(10_000));

files.set('srt/many-cues.srt', Array.from({ length: 20_000 }, (_, index) => `${index + 1}\n00:00:01,000 --> 00:00:02,000\ncue ${index}\n`).join('\n'));
files.set('srt/bad-timing.srt', '1\n99:99:99,999 --> x\ntext\n\n2\n00:00:01,000 --> 00:00:02,000\nok\n\n3\nno timing at all\n');
files.set('vtt/tag-soup.vtt', `WEBVTT\n\n00:01.000 --> 00:02.000\n${'<'.repeat(200_000)}${'&'.repeat(200_000)}\n`);

for (const [name, text] of files) {
  await mkdir(new URL(name.slice(0, name.indexOf('/') + 1), root), { recursive: true });
  await writeFile(new URL(name, root), text);
}
