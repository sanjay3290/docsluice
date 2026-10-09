import { describe, expect, it } from 'vitest';
import srt from '../../../src/readers/subtitles/index.js';
import source from '../../../src/readers/source/index.js';
import { parse } from '../text-family/harness.js';
import { AbortError } from '../../../src/core/errors.js';

describe('subtitle and source readers', () => {
  it('extracts SRT and VTT cues with time ranges in locations', async () => {
    const srtDoc = await parse(
      srt.srt,
      '1\n00:00:01,000 --> 00:00:02,500\nHello\nworld\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n',
    );
    expect(srtDoc.doc.blocks).toMatchObject([
      { kind: 'paragraph', text: 'Hello\nworld', loc: { path: '00:00:01,000 --> 00:00:02,500' } },
      { kind: 'paragraph', text: 'Bye', loc: { path: '00:00:03,000 --> 00:00:04,000' } },
    ]);
    const vttDoc = await parse(srt.vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nCaption\n');
    expect(vttDoc.doc.blocks[0]).toMatchObject({
      kind: 'paragraph',
      text: 'Caption',
      loc: { path: '00:00:01.000 --> 00:00:02.000' },
    });
  });

  it('uses the filename extension as code language and applies output limits', async () => {
    const { doc } = await parse(source, 'const answer = 42;\n', {
      filename: 'example.ts',
      limits: { outputChars: 4 },
    });
    expect(doc.blocks).toMatchObject([{ kind: 'code', language: 'ts', text: 'cons' }]);
    expect(doc.stats.truncated).toBe(true);
  });

  it.each([
    ['file.c', 'c'],
    ['file.cpp', 'cpp'],
    ['file.cs', 'csharp'],
    ['file.css', 'css'],
    ['file.go', 'go'],
    ['file.htm', 'html'],
    ['file.java', 'java'],
    ['file.mjs', 'javascript'],
    ['file.jsx', 'jsx'],
    ['file.kts', 'kotlin'],
    ['file.php', 'php'],
    ['file.py', 'python'],
    ['file.rb', 'ruby'],
    ['file.rs', 'rust'],
    ['file.bash', 'bash'],
    ['file.sql', 'sql'],
    ['file.cts', 'ts'],
    ['file.tsx', 'tsx'],
    ['file.svg', 'xml'],
    ['file.yml', 'yaml'],
    ['FILE.PY', 'python'],
  ])('labels %s as %s', async (filename, language) => {
    const { doc } = await parse(source, 'safe = True\n', { filename });
    expect(doc.blocks).toMatchObject([{ kind: 'code', language, text: 'safe = True\n' }]);
  });

  it('keeps shebangs as inert source and leaves unknown filename extensions unlabeled', async () => {
    const shebang = '#!/usr/bin/env python\nprint("safe")\n';
    const withExtension = await parse(source, shebang, { filename: 'runner.py' });
    expect(withExtension.doc.blocks).toMatchObject([{ kind: 'code', language: 'python', text: shebang }]);
    const unknown = await parse(source, shebang, { filename: 'runner.unknown' });
    expect(unknown.doc.blocks).toMatchObject([{ kind: 'code', text: shebang }]);
    expect(JSON.stringify(unknown.doc.blocks)).not.toContain('language');

    const extensionless = await parse(source, 'line one\n', { filename: 'README' });
    expect(extensionless.doc.blocks).toMatchObject([{ kind: 'code', text: 'line one\n' }]);
    expect(JSON.stringify(extensionless.doc.blocks)).not.toContain('language');

    const noFilename = await parse(source, 'plain source\n');
    expect(noFilename.doc.blocks).toMatchObject([{ kind: 'code', text: 'plain source\n' }]);
    expect(JSON.stringify(noFilename.doc.blocks)).not.toContain('language');
  });

  it('decodes BOM-marked UTF-16 source and rejects binary-looking input', async () => {
    const sourceText = 'let value = "café";\n';
    const utf16 = new Uint8Array(2 + sourceText.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let index = 0; index < sourceText.length; index++) {
      const code = sourceText.charCodeAt(index);
      utf16[2 + index * 2] = code & 0xff;
      utf16[3 + index * 2] = code >> 8;
    }
    const decoded = await parse(source, utf16, { filename: 'sample.js' });
    expect(decoded.doc.encoding).toBe('utf-16le');
    expect(decoded.doc.blocks).toMatchObject([{ kind: 'code', language: 'javascript', text: sourceText }]);

    const binary = await parse(source, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
      filename: 'sample.py',
    });
    expect(binary.doc.blocks).toEqual([]);
  });

  it('truncates source at zero output and propagates pre-aborted signals', async () => {
    const empty = await parse(source, 'sensitive source', { limits: { outputChars: 0 } });
    expect(empty.doc.blocks).toEqual([]);
    expect(empty.doc.stats.truncated).toBe(true);

    const controller = new AbortController();
    controller.abort();
    await expect(parse(source, 'never read', { signal: controller.signal })).rejects.toBeInstanceOf(
      AbortError,
    );
  });

  it('charges subtitle cues against the shared cell budget', async () => {
    const { doc, warnings } = await parse(
      srt.srt,
      '00:00:01,000 --> 00:00:02,000\none\n\n00:00:03,000 --> 00:00:04,000\ntwo',
      { limits: { cells: 1 } },
    );
    expect(doc.blocks).toHaveLength(1);
    expect(warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });
});
