import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DocsluiceError } from '../../src/core/errors.js';
import { fuzzCsv } from '../../fuzz/csv.fuzz.js';
import { fuzzEml } from '../../fuzz/eml.fuzz.js';
import { fuzzEpub } from '../../fuzz/epub.fuzz.js';
import { fuzzHtml } from '../../fuzz/html.fuzz.js';
import { fuzzIcs } from '../../fuzz/ics.fuzz.js';
import { fuzzJson } from '../../fuzz/json.fuzz.js';
import { fuzzMarkdown } from '../../fuzz/markdown.fuzz.js';
import { fuzzMbox } from '../../fuzz/mbox.fuzz.js';
import { fuzzMime } from '../../fuzz/mime.fuzz.js';
import { fuzzMsg } from '../../fuzz/msg.fuzz.js';
import { fuzzNdjson } from '../../fuzz/ndjson.fuzz.js';
import { fuzzRtf } from '../../fuzz/rtf.fuzz.js';
import { fuzzSource } from '../../fuzz/source.fuzz.js';
import { fuzzSubtitles } from '../../fuzz/subtitles.fuzz.js';
import { fuzzTxt } from '../../fuzz/txt.fuzz.js';
import { fuzzVcf } from '../../fuzz/vcf.fuzz.js';
import { fuzzXml } from '../../fuzz/xml.fuzz.js';
import { fuzzYaml } from '../../fuzz/yaml.fuzz.js';

type Target = (bytes: Uint8Array) => void | Promise<void>;
const targets: ReadonlyArray<readonly [string, Target]> = [
  ['csv', fuzzCsv],
  ['eml', fuzzEml],
  ['epub', fuzzEpub],
  ['html', fuzzHtml],
  ['ics', fuzzIcs],
  ['json', fuzzJson],
  ['markdown', fuzzMarkdown],
  ['mbox', fuzzMbox],
  ['mime', fuzzMime],
  ['msg', fuzzMsg],
  ['ndjson', fuzzNdjson],
  ['rtf', fuzzRtf],
  ['source', fuzzSource],
  ['subtitles', fuzzSubtitles],
  ['txt', fuzzTxt],
  ['vcf', fuzzVcf],
  ['xml', fuzzXml],
  ['yaml', fuzzYaml],
];
const manifest = JSON.parse(
  readFileSync(new URL('../../../../hostile/manifest.json', import.meta.url), 'utf8'),
) as Array<{ file: string }>;
const fixtures = manifest.map(
  ({ file }) => new Uint8Array(readFileSync(new URL('../../../../hostile/' + file, import.meta.url))),
);

describe('Package B bounded hostile and fuzz adapters', () => {
  it.each(targets)(
    '%s handles every current shared hostile file without execution or prototype mutation',
    async (_name, target) => {
      const before = Object.getOwnPropertyDescriptors(Object.prototype);
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network use is forbidden.'));
      try {
        // These are adapter checks: each target applies its documented input/time/output caps.
        // Format-specific manifest outcomes and peak heap remain the shared hostile runner's job.
        for (const bytes of fixtures) {
          try {
            await target(bytes);
          } catch (error) {
            if (!(error instanceof DocsluiceError)) throw error;
          }
        }
        const random = new Uint8Array(4096);
        let state = 0x3290;
        for (let index = 0; index < random.length; index++) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          random[index] = state & 255;
        }
        for (const bytes of [
          new Uint8Array(),
          random,
          new TextEncoder().encode('__proto__: literal\nconstructor: value\n'),
        ]) {
          try {
            await target(bytes);
          } catch (error) {
            if (!(error instanceof DocsluiceError)) throw error;
          }
        }
        expect(fetch).not.toHaveBeenCalled();
        expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
      } finally {
        fetch.mockRestore();
      }
    },
    30_000,
  );
});
