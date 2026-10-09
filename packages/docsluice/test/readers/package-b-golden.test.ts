import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FormatId } from '../../src/core/model.js';
import { createExtractor } from '../../src/core/extract.js';
import { ReaderRegistry } from '../../src/core/registry.js';
import type { Reader } from '../../src/core/reader.js';
import { toJSON } from '../../src/render/json.js';
import { toMarkdown } from '../../src/render/markdown.js';
import csvReader, { tsvReader } from '../../src/readers/csv/index.js';
import emlReader from '../../src/readers/eml/index.js';
import epubReader from '../../src/readers/epub/index.js';
import htmlReader from '../../src/readers/html/index.js';
import icsReader from '../../src/readers/ics/index.js';
import jsonReader from '../../src/readers/json/index.js';
import markdownReader from '../../src/readers/markdown/index.js';
import mboxReader from '../../src/readers/mbox/index.js';
import msgReader from '../../src/readers/msg/index.js';
import ndjsonReader from '../../src/readers/ndjson/index.js';
import rtfReader from '../../src/readers/rtf/index.js';
import sourceReader from '../../src/readers/source/index.js';
import { srt, vtt } from '../../src/readers/subtitles/index.js';
import txtReader from '../../src/readers/txt/index.js';
import vcfReader from '../../src/readers/vcf/index.js';
import xmlReader from '../../src/readers/xml/index.js';
import yamlReader from '../../src/readers/yaml/index.js';

interface GoldenFixture {
  readonly file: string;
  readonly format: FormatId;
}

const fixtures: readonly GoldenFixture[] = [
  { file: 'txt/paragraphs.txt', format: 'txt' },
  { file: 'txt/utf16le-bom.txt', format: 'txt' },
  { file: 'txt/windows-1252.txt', format: 'txt' },
  { file: 'markdown/constructs.md', format: 'markdown' },
  { file: 'csv/rfc4180-crlf.csv', format: 'csv' },
  { file: 'csv/semicolon.csv', format: 'csv' },
  { file: 'csv/pipe-ragged.csv', format: 'csv' },
  { file: 'csv/unterminated-quote.csv', format: 'csv' },
  { file: 'tsv/bom-tabs.tsv', format: 'tsv' },
  { file: 'json/mixed-leaves.json', format: 'json' },
  { file: 'json/dangerous-keys.json', format: 'json' },
  { file: 'xml/namespaces-and-paths.xml', format: 'xml' },
  { file: 'html/blog-post.html', format: 'html' },
  { file: 'html/docs-page.html', format: 'html' },
  { file: 'html/entities.html', format: 'html' },
  { file: 'eml/plain.eml', format: 'eml' },
  { file: 'eml/html-only.eml', format: 'eml' },
  { file: 'eml/alternative.eml', format: 'eml' },
  { file: 'eml/encoded-utf8.eml', format: 'eml' },
  { file: 'eml/encoded-iso8859-1.eml', format: 'eml' },
  { file: 'eml/rfc2231-qp-base64.eml', format: 'eml' },
  { file: 'eml/mixed-order-attachments.eml', format: 'eml' },
  { file: 'rtf/table-and-list.rtf', format: 'rtf' },
  { file: 'rtf/wordpad-unicode.rtf', format: 'rtf' },
  { file: 'rtf/japanese-codepage.rtf', format: 'rtf' },
  { file: 'epub/tiny-epub2.epub', format: 'epub' },
  { file: 'epub/tiny-epub3.epub', format: 'epub' },
  { file: 'msg/test_outlook_msg.msg', format: 'msg' },
  { file: 'mbox/mboxrd-two-messages.mbox', format: 'mbox' },
  { file: 'yaml/simple-and-alias.yaml', format: 'yaml' },
  { file: 'yaml/alias-chain.yaml', format: 'yaml' },
  { file: 'ndjson/records.ndjson', format: 'ndjson' },
  { file: 'ics/folded-event.ics', format: 'ics' },
  { file: 'vcf/folded-contact.vcf', format: 'vcf' },
  { file: 'srt/two-cues.srt', format: 'srt' },
  { file: 'vtt/two-cues.vtt', format: 'vtt' },
  { file: 'source/example.ts', format: 'source' },
];

const readers: readonly Reader[] = [
  txtReader,
  markdownReader,
  csvReader,
  tsvReader,
  jsonReader,
  xmlReader,
  htmlReader,
  emlReader,
  rtfReader,
  epubReader,
  msgReader,
  mboxReader,
  yamlReader,
  ndjsonReader,
  icsReader,
  vcfReader,
  srt,
  vtt,
  sourceReader,
];

const registry = new ReaderRegistry();
for (const reader of readers) {
  registry.add({ id: reader.id, mimeTypes: reader.mimeTypes, load: () => Promise.resolve(reader) });
}

const extract = createExtractor(registry);
const corpusRoot = fileURLToPath(new URL('../../../../corpus/', import.meta.url));
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('Package B corpus goldens', () => {
  it.each(fixtures)('$file', async ({ file, format }) => {
    const bytes = readFileSync(`${corpusRoot}${file}`);
    const document = await extract(bytes, {
      format,
      filename: file.slice(file.lastIndexOf('/') + 1),
      children: 'list',
    });

    expect(toJSON(document, { stable: true })).toBe(
      decode(readFileSync(`${corpusRoot}${file}.expected.json`)),
    );
    expect(toMarkdown(document)).toBe(decode(readFileSync(`${corpusRoot}${file}.expected.md`)));
  });
});
