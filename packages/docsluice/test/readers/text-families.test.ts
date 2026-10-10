import { describe, expect, it, vi } from 'vitest';
import { detect, extract } from '../../src/index.js';
import type { Block, DocsluiceDocument } from '../../src/core/model.js';
import { fuzzTextFamilies } from '../../fuzz/text-families.fuzz.js';
import { makeZip } from '../helpers/zip.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const read = (text: string, options: Parameters<typeof extract>[1] = {}) => extract(bytes(text), options);
const paragraphs = (doc: DocsluiceDocument) =>
  doc.blocks.flatMap((block: Block) => (block.kind === 'paragraph' ? [block.text] : []));
const tableRows = (doc: DocsluiceDocument) =>
  doc.blocks.flatMap((block: Block) =>
    block.kind === 'table' ? [block.rows.map((row) => row.map((cell) => cell.text))] : [],
  );

describe('text family detection', () => {
  it.each([
    ['BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', 'ics'],
    ['begin:vcard\nFN:x\nend:vcard\n', 'vcf'],
    ['WEBVTT\n\n00:01.000 --> 00:02.000\nhi\n', 'vtt'],
    ['WEBVTT - title\n', 'vtt'],
    ['1\r\n00:00:01,000 --> 00:00:02,000\r\nhi\r\n', 'srt'],
    ['{"a":1}\n{"a":2}\n', 'ndjson'],
    ['{"a":1}\n{"a":2}\n{"cut', 'ndjson'],
  ])('sniffs %j as %s', async (text, format) => {
    expect((await detect(bytes(text))).format).toBe(format);
  });

  it.each([
    ['WEBVTTX\n', 'txt'],
    ['12\nnot a timing line\n', 'txt'],
    ['{"a":1}\nnot json\n{"b":2}\n', 'txt'],
    ['{"a":1}\n', 'json'],
  ])('does not mistake %j', async (text, format) => {
    expect((await detect(bytes(text))).format).toBe(format);
  });

  it('reads loose text named or typed as a text family as that format, without a mismatch warning', async () => {
    const yaml = await read('a: 1\nb: [x, y, z]\nc: [1, 2, 3]\n', { filename: 'config.yml' });
    expect(yaml.format).toBe('yaml');
    expect(yaml.warnings).toEqual([]);
    expect((await read('# Title\n\nkey: value\n', { mimeType: 'application/yaml' })).format).toBe('yaml');
    expect((await read('{"a":1}\nbad\n', { filename: 'log.jsonl' })).format).toBe('ndjson');
    // Hints that disagree select nothing.
    expect((await read('a: 1\n', { filename: 'a.yaml', mimeType: 'text/vtt' })).format).toBe('txt');
  });

  it('keeps commented source code as text with a code block', async () => {
    const python = await read('# Heading-like comment\n# another\n\nprint("hi")\n', { filename: 'tool.py' });
    expect(python.format).toBe('txt');
    expect(python.blocks).toMatchObject([{ kind: 'code', language: 'python' }]);
    expect(python.blocks[0]!.kind === 'code' && python.blocks[0]!.text.includes('print("hi")')).toBe(true);
    const typescript = await read('export const x = 1;\n', { filename: 'src/x.TS' });
    expect(typescript.blocks).toMatchObject([{ kind: 'code', language: 'typescript' }]);
    expect((await read('   \n', { filename: 'empty.go' })).blocks).toEqual([]);
    const plain = await read('just text\n', { filename: 'notes.txt' });
    expect(plain.blocks).toMatchObject([{ kind: 'paragraph' }]);
  });
});

describe('YAML reader', () => {
  it('gives key paths for mappings, sequences and block scalars, and keeps the source', async () => {
    const doc = await read(
      [
        'name: Survey  # comment',
        'nested:',
        '  inner: "quoted # not a comment"',
        "  single: 'it''s'",
        '  list:',
        '    - first',
        '    - key: value',
        '      other: 2',
        '    - - deep',
        '      - deeper',
        'literal: |',
        '  line one',
        '  line two',
        '',
        'folded: >-',
        '  joined',
        '  words',
        'flow: {a: 1, b: [2, 3]}',
        'anchor: &base',
        '  x: 1',
        'alias: *base',
        '"spaced key": v',
        '---',
        'second: doc',
      ].join('\n'),
      { format: 'yaml' },
    );
    expect(paragraphs(doc)).toEqual([
      '$.name: Survey',
      '$.nested.inner: quoted # not a comment',
      "$.nested.single: it's",
      '$.nested.list[0]: first',
      '$.nested.list[1].key: value',
      '$.nested.list[1].other: 2',
      '$.nested.list[2][0]: deep',
      '$.nested.list[2][1]: deeper',
      '$.literal: line one\nline two',
      '$.folded: joined words',
      '$.flow: {a: 1, b: [2, 3]}',
      '$.anchor.x: 1',
      '$.alias: *base',
      '$["spaced key"]: v',
      '$.second: doc',
    ]);
    expect(doc.blocks.at(-1)).toMatchObject({ kind: 'code', language: 'yaml' });
    expect(doc.blocks[0]!.loc.path).toBe('$.name');
  });

  it('never expands aliases and stops nesting at the block depth limit', async () => {
    const bomb = await read('a: &a [x, x, x]\nb: &b [*a, *a, *a]\nc: [*b, *b, *b]\n', { format: 'yaml' });
    // Anchors and aliases stay as written: nothing is expanded.
    expect(paragraphs(bomb)).toEqual(['$.a: &a [x, x, x]', '$.b: &b [*a, *a, *a]', '$.c: [*b, *b, *b]']);
    const deep =
      Array.from({ length: 10 }, (_, depth) => `${' '.repeat(depth)}k${depth}:`).join('\n') +
      '\n          leaf: 1';
    const doc = await read(deep, { format: 'yaml', limits: { blockDepth: 4 } });
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['DEPTH_LIMIT']);
    expect(paragraphs(doc)).toEqual(['$.k0.k1.k2.k3.leaf: 1']);
  });

  it('skips the source code block for large inputs', async () => {
    const doc = await read(`big: ${'x'.repeat(70_000)}\n`, { format: 'yaml' });
    expect(doc.blocks.map((block) => block.kind)).toEqual(['paragraph']);
  });
});

describe('NDJSON reader', () => {
  it('reads each line as a record, skips blank lines and counts malformed and too-deep lines', async () => {
    const doc = await read(
      `{"a":1}\n\n[true,null]\nnot json\n${'['.repeat(10)}${']'.repeat(10)}\n{"b":"x"}\n`,
      {
        format: 'ndjson',
        limits: { blockDepth: 5 },
      },
    );
    expect(paragraphs(doc)).toEqual(['$[0].a: 1', '$[1][0]: true', '$[1][1]: null', '$[4].b: x']);
    expect(doc.warnings.map((warning) => warning.message)).toEqual([
      'Limit "blockDepth" is 5; observed 6. Further work was skipped.',
      '1 record(s) nest deeper than the block depth limit of 5 and were skipped.',
      '1 line(s) are not valid JSON and were skipped.',
    ]);
  });
});

describe('NDJSON malformed lines', () => {
  it('counts lines that cannot be JSON without calling JSON.parse, and still parses the rest', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const lines = [' x', 'junk', '{"a":1}', '  ', '[1,2', 'true', '-', '"s"', 'nul'];
      const doc = await read(`${lines.join('\n')}\n`, { filename: 'log.ndjson' });
      expect(doc.warnings).toEqual([
        { code: 'UNREADABLE_PART', message: '5 line(s) are not valid JSON and were skipped.' },
      ]);
      // Only lines that start and end like a JSON value reach the parser; ` x`, `junk` and `-` do not.
      expect(parse.mock.calls.map(([text]) => text)).toEqual(['{"a":1}', '[1,2', 'true', '"s"', 'nul']);
    } finally {
      parse.mockRestore();
    }
  });
});

describe('iCalendar reader', () => {
  const calendar = [
    'BEGIN:VCALENDAR',
    'X-WR-CALNAME:Team',
    'BEGIN:VEVENT',
    'UID:1',
    'SUMMARY:Planning\\, round 2',
    'DTSTART:20260101T090000Z',
    'DTEND;VALUE=DATE:20260102',
    'EXDATE;TZID=Europe/Paris:20260108T090000,20260115T090000',
    'DESCRIPTION:Line one\\nLine two that is fol',
    ' ded here',
    'ORGANIZER;CN="Ada; Field":mailto:ada@example.org',
    'ATTENDEE:mailto:grace@example.org',
    'item1.LOCATION:Room 4',
    'X-PRIVATE:hidden',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Paris',
    'END:VTIMEZONE',
    'END:VCALENDAR',
  ].join('\r\n');

  it('unfolds lines and gives one field table per event, to-do or alarm', async () => {
    const doc = await read(calendar);
    expect(doc.format).toBe('ics');
    expect(doc.metadata.title).toBe('Team');
    expect(tableRows(doc)).toEqual([
      [
        ['Field', 'Value'],
        ['SUMMARY', 'Planning, round 2'],
        ['DTSTART', '2026-01-01T09:00:00Z'],
        ['DTEND', '2026-01-02'],
        ['EXDATE', '2026-01-08T09:00:00 (Europe/Paris), 2026-01-15T09:00:00 (Europe/Paris)'],
        ['DESCRIPTION', 'Line one\nLine two that is folded here'],
        ['ORGANIZER', 'Ada; Field <ada@example.org>'],
        ['ATTENDEE', 'grace@example.org'],
        ['LOCATION', 'Room 4'],
      ],
      [
        ['Field', 'Value'],
        ['TRIGGER', '-PT15M'],
      ],
    ]);
  });

  it('leaves out organizers and attendees without metadata', async () => {
    const doc = await read(calendar, { metadata: false });
    expect(tableRows(doc)[0]!.map((row) => row[0])).not.toContain('ORGANIZER');
    expect(tableRows(doc)[0]!.map((row) => row[0])).not.toContain('ATTENDEE');
  });

  it('merges components past the depth limit into their parent, with a warning', async () => {
    const doc = await read(`BEGIN:VCALENDAR\r\n${'BEGIN:VEVENT\r\nSUMMARY:x\r\n'.repeat(5)}`, {
      limits: { blockDepth: 3 },
    });
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['DEPTH_LIMIT']);
    expect(tableRows(doc).length).toBe(2);
  });
});

describe('vCard reader', () => {
  const cards = [
    'BEGIN:VCARD',
    'VERSION:4.0',
    'FN:Ada Field',
    'N:Field;Ada;;Dr.;PhD',
    'ORG:Lab\\, North;Team',
    'EMAIL:ada@example.org',
    'TEL;VALUE=uri:tel:+1-555-0100',
    'ADR:;;1 Road;Town;;9;Land',
    'BDAY:19800214',
    'PHOTO:data:image/png;base64,AAAA',
    'item2.URL:https://example.org',
    'END:VCARD',
    'BEGIN:VCARD',
    'FN:Second',
    'END:VCARD',
  ].join('\n');

  it('gives one table per card with structured names and addresses', async () => {
    const doc = await read(cards);
    expect(doc.format).toBe('vcf');
    expect(tableRows(doc)).toEqual([
      [
        ['Field', 'Value'],
        ['FN', 'Ada Field'],
        ['N', 'Dr. Ada Field PhD'],
        ['ORG', 'Lab, North, Team'],
        ['EMAIL', 'ada@example.org'],
        ['TEL', '+1-555-0100'],
        ['ADR', '1 Road, Town, 9, Land'],
        ['BDAY', '1980-02-14'],
        ['URL', 'https://example.org'],
      ],
      [
        ['Field', 'Value'],
        ['FN', 'Second'],
      ],
    ]);
  });

  it('keeps only names, organization and title without metadata', async () => {
    const doc = await read(cards, { metadata: false });
    expect(tableRows(doc)[0]!.map((row) => row[0])).toEqual(['Field', 'FN', 'N', 'ORG']);
  });
});

describe('subtitle readers', () => {
  it('reads SubRip cues as paragraphs with the time range as the path', async () => {
    const doc = await read(
      '1\n00:00:01,500 --> 00:00:03,000\n<b>Bold</b> &amp; plain\n\n2\nbroken\n\n3\n01:00:00,000 --> 01:00:01,000\n\n',
    );
    expect(doc.format).toBe('srt');
    expect(doc.blocks).toMatchObject([
      { kind: 'paragraph', text: 'Bold & plain', loc: { path: '00:00:01.500-00:00:03.000' } },
    ]);
    expect(doc.warnings).toEqual([
      { code: 'UNREADABLE_PART', message: '1 block(s) have no cue timing line and were skipped.' },
    ]);
  });

  it('reads WebVTT cues with optional hours, identifiers, settings and tags', async () => {
    const doc = await read(
      'WEBVTT\nKind: captions\n\nNOTE\nnot a cue\n\nREGION\nid:r\n\nid-1\n00:02.000 --> 00:04.000 line:0 region:r\n<v.loud Ada>Hello</v> <c.x>there</c><00:03.000> &lt;3 &unknown; a < b\n',
    );
    expect(doc.format).toBe('vtt');
    expect(doc.blocks).toMatchObject([
      {
        kind: 'paragraph',
        text: 'Hello there <3 &unknown; a < b',
        loc: { path: '00:00:02.000-00:00:04.000' },
      },
    ]);
  });

  it('prefixes cue paths with the child path inside a container', async () => {
    const zip = makeZip([{ name: 'subs/a.srt', data: bytes('1\n00:00:01,000 --> 00:00:02,000\nhi\n') }]);
    const child = (await extract(zip)).children[0]!.document!;
    expect(child.format).toBe('srt');
    expect(child.blocks[0]!.loc.path).toBe('subs/a.srt/00:00:01.000-00:00:02.000');
  });
});

describe('text family fuzz target', () => {
  it('survives sample inputs', async () => {
    for (const text of [
      'a: &x\n  - *x\n',
      'BEGIN:VCARD\n',
      'WEBVTT\n\n<<<',
      '{"a":',
      '1\n00:00:01,000 --> \n',
    ]) {
      await expect(fuzzTextFamilies(bytes(text))).resolves.toBeUndefined();
    }
  });
});
