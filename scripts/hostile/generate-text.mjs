import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Hostile TXT and Markdown inputs: deep nesting and unclosed inline delimiters.
const markdown = new URL('../../hostile/markdown/', import.meta.url);
await mkdir(markdown, { recursive: true });
await writeFile(new URL('deep-blockquote-10000.md', markdown), `${'>'.repeat(10_000)} deep\n`);
await writeFile(
  new URL('deep-list-300.md', markdown),
  `${Array.from({ length: 300 }, (_, level) => `${'  '.repeat(level)}- item`).join('\n')}\n`,
);
await writeFile(new URL('unclosed-inline-200k.md', markdown), `${'[`<!['.repeat(40_000)}\n`);

const txt = new URL('../../hostile/txt/', import.meta.url);
await mkdir(txt, { recursive: true });
await writeFile(new URL('blank-lines-200k.txt', txt), `${' \r\n  \n'.repeat(50_000)}end\n`);
