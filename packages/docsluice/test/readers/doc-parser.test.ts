import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { DEFAULT_LIMITS, resolveLimits } from '../../src/core/limits.js';
import { CorruptFileError, EncryptedError } from '../../src/core/errors.js';
import { openCfb } from '../../src/ole/index.js';
import { parseDocStreams } from '../../src/readers/doc/parser.js';
import { docReader } from '../../src/readers/doc/index.js';
import type { ReadContext } from '../../src/core/reader.js';
import { DocBuilder } from '../../src/core/builder.js';

interface Piece {
  text: string;
  compressed: boolean;
}

function makeStreams(
  pieces: Piece[],
  options: { encrypted?: boolean; nFib?: number } = {},
): {
  wordDocument: Uint8Array;
  zeroTable: Uint8Array;
  oneTable: Uint8Array;
} {
  const wordDocument = new Uint8Array(2048);
  const fib = new DataView(wordDocument.buffer);
  fib.setUint16(0, 0xa5ec, true);
  fib.setUint16(2, options.nFib ?? 0x00c1, true);
  fib.setUint16(10, options.encrypted ? 0x0100 : 0, true);
  fib.setUint16(32, 14, true);
  fib.setUint16(62, 22, true);
  const lw = 64;
  const cpCount = pieces.reduce((count, piece) => count + piece.text.length, 0);
  fib.setUint32(lw + 3 * 4, cpCount, true);

  const table = new Uint8Array(5 + pieces.length * 12 + 4);
  const tableView = new DataView(table.buffer);
  table[0] = 0x02;
  tableView.setUint32(1, pieces.length * 12 + 4, true);
  let cp = 0;
  for (let index = 0; index < pieces.length; index++) {
    tableView.setInt32(5 + index * 4, cp, true);
    cp += pieces[index]!.text.length;
  }
  tableView.setInt32(5 + pieces.length * 4, cp, true);
  let dataOffset = 512;
  const dataView = new DataView(wordDocument.buffer);
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]!;
    const pcdOffset = 5 + (pieces.length + 1) * 4 + index * 8;
    const byteOffset = dataOffset;
    if (piece.compressed) {
      for (let charIndex = 0; charIndex < piece.text.length; charIndex++) {
        const code = piece.text.charCodeAt(charIndex);
        wordDocument[dataOffset++] = code <= 0xff ? code : 0x3f;
      }
      tableView.setUint32(pcdOffset + 2, (byteOffset * 2) | 0x4000_0000, true);
    } else {
      for (let charIndex = 0; charIndex < piece.text.length; charIndex++) {
        dataView.setUint16(dataOffset, piece.text.charCodeAt(charIndex), true);
        dataOffset += 2;
      }
      tableView.setUint32(pcdOffset + 2, byteOffset, true);
    }
  }
  const fibFcLcb = 154;
  fib.setUint16(152, 34, true);
  fib.setUint32(fibFcLcb + 33 * 8, 0, true);
  fib.setUint32(fibFcLcb + 33 * 8 + 4, table.byteLength, true);
  return { wordDocument, zeroTable: table, oneTable: new Uint8Array(0) };
}

function parse(pieces: Piece[], options?: { encrypted?: boolean }) {
  const streams = makeStreams(pieces, options);
  return parseDocStreams(
    streams.wordDocument,
    { zeroTable: streams.zeroTable, oneTable: streams.oneTable },
    new Budget(DEFAULT_LIMITS),
  );
}

describe('MS-DOC parser', () => {
  it('adapts through ReadContext, reuses CFB, reads only the selected table, and prefixes locations', async () => {
    const fixture = new Uint8Array(
      readFileSync(fileURLToPath(new URL('../../../../corpus/doc/doc-legacy.doc', import.meta.url))),
    );
    const budget = new Budget(DEFAULT_LIMITS);
    const archive = openCfb(fixture, budget);
    const reads: string[] = [];
    const cfb = {
      entries: archive.entries,
      read(path: string): Uint8Array {
        reads.push(path);
        if (path === '0Table' && reads.some((read) => read === '1Table')) {
          throw new Error('the unselected table stream must not be read');
        }
        if (path === '1Table' && reads.some((read) => read === '0Table')) {
          throw new Error('the unselected table stream must not be read');
        }
        return archive.read(path);
      },
    };
    const out = new DocBuilder('doc', 'application/msword', budget);
    const ctx = {
      bytes: fixture,
      options: {} as ReadContext['options'],
      budget,
      warnings: budget.warnings,
      out,
      path: 'bundle/legacy.doc',
      extractChild: async () => {},
      cfb,
    } satisfies ReadContext;

    await docReader.read(ctx);
    const document = out.finish();
    expect(document.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'heading' })]));
    expect(document.blocks.every((block) => block.loc.path === 'bundle/legacy.doc')).toBe(true);
    expect(reads).toContain('WordDocument');
    expect(reads.filter((path) => path === '0Table' || path === '1Table')).toHaveLength(1);
    expect(budget.cells).toBe(4);
    expect(budget.outputChars).toBeGreaterThan(0);
  });

  it('opens CFB when the context has no pre-opened archive', async () => {
    const fixture = new Uint8Array(
      readFileSync(fileURLToPath(new URL('../../../../corpus/doc/doc-legacy.doc', import.meta.url))),
    );
    const budget = new Budget(DEFAULT_LIMITS);
    const out = new DocBuilder('doc', 'application/msword', budget);
    const ctx = {
      bytes: fixture,
      options: {} as ReadContext['options'],
      budget,
      warnings: budget.warnings,
      out,
      path: '',
      extractChild: async () => {},
    } satisfies ReadContext;
    await docReader.read(ctx);
    expect(out.finish().blocks.length).toBeGreaterThan(0);
  });

  it('rejects a compound file without the required WordDocument stream', async () => {
    const budget = new Budget(DEFAULT_LIMITS);
    const out = new DocBuilder('doc', 'application/msword', budget);
    await expect(
      docReader.read({
        bytes: new Uint8Array(0),
        options: {} as ReadContext['options'],
        budget,
        warnings: budget.warnings,
        out,
        path: '',
        extractChild: async () => {},
        cfb: { entries: [], read: () => new Uint8Array(0) },
      }),
    ).rejects.toThrow(CorruptFileError);
  });

  it('extracts the licensed LibreOffice DOC fixture and meets native DOCX text recall', () => {
    const fixture = readFileSync(
      fileURLToPath(new URL('../../../../corpus/doc/doc-legacy.doc', import.meta.url)),
    );
    const nativeText = new TextDecoder().decode(
      readFileSync(
        fileURLToPath(new URL('../../../../corpus/doc/doc-legacy.docx.native.txt', import.meta.url)),
      ),
    );
    const budget = new Budget(DEFAULT_LIMITS);
    const archive = openCfb(new Uint8Array(fixture), budget);
    const stream = (name: string): Uint8Array => {
      for (const entry of archive.entries) {
        budget.tick();
        if (entry.type === 'stream' && entry.path === name) return archive.read(entry.path);
      }
      return new Uint8Array(0);
    };
    const blocks = parseDocStreams(
      stream('WordDocument'),
      { zeroTable: stream('0Table'), oneTable: stream('1Table') },
      budget,
    );
    const expected = JSON.parse(
      new TextDecoder().decode(
        readFileSync(
          fileURLToPath(new URL('../../../../corpus/doc/doc-legacy.doc.blocks.json', import.meta.url)),
        ),
      ),
    ) as unknown;
    expect(blocks).toEqual(expected);
    const extracted = blocks
      .map((block) =>
        block.kind === 'paragraph' || block.kind === 'heading'
          ? block.text
          : block.rows.map((row) => row.map((cell) => cell.text).join('\t')).join('\n'),
      )
      .join('\n');
    const sourceChars = Array.from(
      nativeText.normalize('NFC').matchAll(/[\p{L}\p{N}]/gu),
      (match) => match[0],
    );
    const counts = new Map<string, number>();
    for (const character of sourceChars) counts.set(character, (counts.get(character) ?? 0) + 1);
    let recalled = 0;
    for (const character of Array.from(
      extracted.normalize('NFC').matchAll(/[\p{L}\p{N}]/gu),
      (match) => match[0],
    )) {
      const count = counts.get(character) ?? 0;
      if (count > 0) {
        recalled++;
        counts.set(character, count - 1);
      }
    }
    expect(recalled / sourceChars.length).toBe(1);
  });

  it('walks CP boundaries across compressed Windows-1252 and Unicode pieces', () => {
    const blocks = parse([
      { text: 'First ', compressed: true },
      { text: '“line”\rSecond\r', compressed: false },
    ]);
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'First “line”' },
      { kind: 'paragraph', text: 'Second' },
    ]);
  });

  it('keeps field results while suppressing field instructions', () => {
    expect(parse([{ text: 'A\u0013DATE\u0014July 4\u0015 B\r', compressed: true }])).toEqual([
      { kind: 'paragraph', text: 'AJuly 4 B' },
    ]);
  });

  it('turns cell marks in a row into a table block', () => {
    expect(parse([{ text: 'Name\u0007Value\u0007\rTail\r', compressed: true }])).toEqual([
      { kind: 'table', rows: [[{ text: 'Name' }, { text: 'Value' }]] },
      { kind: 'paragraph', text: 'Tail' },
    ]);
  });

  it('rejects encrypted documents before attempting to parse the CLX', () => {
    const streams = makeStreams([], { encrypted: true });
    expect(() =>
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: streams.zeroTable, oneTable: streams.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(EncryptedError);
  });

  it('rejects the hostile encrypted DOC fixture', () => {
    const fixture = readFileSync(
      fileURLToPath(new URL('../../../../hostile/doc/encrypted.doc', import.meta.url)),
    );
    const budget = new Budget(DEFAULT_LIMITS);
    const archive = openCfb(new Uint8Array(fixture), budget);
    const stream = (name: string): Uint8Array => {
      for (const entry of archive.entries) {
        budget.tick();
        if (entry.type === 'stream' && entry.path === name) return archive.read(entry.path);
      }
      return new Uint8Array(0);
    };
    expect(() =>
      parseDocStreams(
        stream('WordDocument'),
        { zeroTable: stream('0Table'), oneTable: stream('1Table') },
        budget,
      ),
    ).toThrow(EncryptedError);
  });

  it('rejects the encrypted hostile fixture through the production reader adapter', async () => {
    const fixture = new Uint8Array(
      readFileSync(fileURLToPath(new URL('../../../../hostile/doc/encrypted.doc', import.meta.url))),
    );
    const budget = new Budget(DEFAULT_LIMITS);
    const out = new DocBuilder('doc', 'application/msword', budget);
    await expect(
      docReader.read({
        bytes: fixture,
        options: {} as ReadContext['options'],
        budget,
        warnings: budget.warnings,
        out,
        path: '',
        extractChild: async () => {},
      }),
    ).rejects.toBeInstanceOf(EncryptedError);
  });

  it('rejects descending CP boundaries', () => {
    const streams = makeStreams([{ text: 'hello\r', compressed: true }]);
    const table = streams.zeroTable.slice();
    new DataView(table.buffer).setInt32(5 + 4, -1, true);
    expect(() =>
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: table, oneTable: streams.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(CorruptFileError);
  });

  it('requires PlcPcd to begin at CP zero', () => {
    const streams = makeStreams([{ text: 'x\r', compressed: true }]);
    const table = streams.zeroTable.slice();
    new DataView(table.buffer, table.byteOffset, table.byteLength).setInt32(5, 1, true);
    expect(() =>
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: table, oneTable: streams.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(CorruptFileError);
  });

  it('honors fWhichTblStm and reads the selected 1Table stream', () => {
    const streams = makeStreams([{ text: 'Selected\r', compressed: true }]);
    new DataView(streams.wordDocument.buffer).setUint16(10, 0x0200, true);
    expect(
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: new Uint8Array(0), oneTable: streams.zeroTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toEqual([{ kind: 'paragraph', text: 'Selected' }]);
  });

  it('preflights cumulative staged text and returns accepted partial output', () => {
    const streams = makeStreams([{ text: 'ABCD\r', compressed: true }]);
    const budget = new Budget(resolveLimits({ outputChars: 2 }));
    expect(
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: streams.zeroTable, oneTable: streams.oneTable },
        budget,
      ),
    ).toEqual([{ kind: 'paragraph', text: 'AB' }]);
    expect(budget.truncated).toBe(true);
    expect(budget.warnings.warnings[0]?.code).toBe('TRUNCATED');
  });

  it('returns accepted text when an output limit stops parsing before later pieces', () => {
    const streams = makeStreams([
      { text: 'ABC\r', compressed: true },
      { text: 'DEF\r', compressed: true },
    ]);
    const budget = new Budget(resolveLimits({ outputChars: 1 }));
    expect(
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: streams.zeroTable, oneTable: streams.oneTable },
        budget,
      ),
    ).toEqual([{ kind: 'paragraph', text: 'A' }]);
    expect(budget.truncated).toBe(true);
  });

  it('returns accepted table cells when a cell limit stops parsing before later pieces', () => {
    const streams = makeStreams([
      { text: 'A\u0007B\u0007\r', compressed: true },
      { text: 'tail\r', compressed: true },
    ]);
    const budget = new Budget(resolveLimits({ cells: 1 }));
    expect(
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: streams.zeroTable, oneTable: streams.oneTable },
        budget,
      ),
    ).toEqual([{ kind: 'table', rows: [[{ text: 'A' }]] }]);
    expect(budget.cells).toBe(2);
    expect(budget.truncated).toBe(true);
  });

  it('rejects piece text that points beyond the WordDocument stream', () => {
    const streams = makeStreams([{ text: 'hello\r', compressed: true }]);
    const table = streams.zeroTable.slice();
    new DataView(table.buffer, table.byteOffset, table.byteLength).setUint32(
      15,
      (2048 * 2) | 0x4000_0000,
      true,
    );
    expect(() =>
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: table, oneTable: streams.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(CorruptFileError);
  });

  it('decodes Windows-1252 punctuation and undefined C1 bytes safely', () => {
    expect(parse([{ text: '\u0080\u0082\u0085\u0093\u0094\u0099\u0081\r', compressed: true }])).toEqual([
      { kind: 'paragraph', text: '€‚…“”™�' },
    ]);
  });

  it('maps the Windows-1252 special-byte range according to FcCompressed', () => {
    const bytes = Array.from({ length: 0x20 }, (_, index) => String.fromCharCode(index + 0x80)).join('');
    expect(parse([{ text: `${bytes}\r`, compressed: true }])).toEqual([
      { kind: 'paragraph', text: '€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž��‘’“”•–—˜™š›œ�žŸ' },
    ]);
  });

  it('preserves tabs and line breaks from Unicode pieces and skips unsupported controls', () => {
    expect(parse([{ text: 'A\tB\nC\u0001D\r', compressed: false }])).toEqual([
      { kind: 'paragraph', text: 'A\tB\nCD' },
    ]);
  });

  it('accepts the empty main document piece table', () => {
    expect(parse([])).toEqual([]);
  });

  it('skips a bounded CLX property run before its piece table', () => {
    const streams = makeStreams([{ text: 'Prc\r', compressed: true }]);
    const table = new Uint8Array(streams.zeroTable.length + 4);
    table.set([0x01, 1, 0, 0xaa]);
    table.set(streams.zeroTable, 4);
    new DataView(streams.wordDocument.buffer).setUint32(154 + 33 * 8 + 4, table.length, true);
    expect(
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: table, oneTable: streams.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toEqual([{ kind: 'paragraph', text: 'Prc' }]);
  });

  it('groups adjacent table rows and retains an unmarked final cell', () => {
    expect(parse([{ text: 'A\u0007B\rC\u0007D\rE\u0007F\r', compressed: true }])).toEqual([
      {
        kind: 'table',
        rows: [
          [{ text: 'A' }, { text: 'B' }],
          [{ text: 'C' }, { text: 'D' }],
          [{ text: 'E' }, { text: 'F' }],
        ],
      },
    ]);
  });

  it('uses repeated cell marks as a row boundary in Word table text', () => {
    expect(parse([{ text: 'A\u0007B\u0007\u0007C\u0007D\u0007\u0007', compressed: true }])).toEqual([
      {
        kind: 'table',
        rows: [
          [{ text: 'A' }, { text: 'B' }],
          [{ text: 'C' }, { text: 'D' }],
        ],
      },
    ]);
  });

  it('handles a CLX that ends after a well-bounded property record', () => {
    const streams = makeStreams([{ text: 'x\r', compressed: true }]);
    const table = Uint8Array.from([0x01, 0, 0]);
    new DataView(streams.wordDocument.buffer).setUint32(154 + 33 * 8 + 4, table.length, true);
    expect(() =>
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: table, oneTable: streams.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(CorruptFileError);
  });

  it('rejects inconsistent PlcPcd sizing', () => {
    const streams = makeStreams([{ text: 'x\r', compressed: true }]);
    const table = streams.zeroTable.slice();
    new DataView(table.buffer).setUint32(1, new DataView(table.buffer).getUint32(1, true) - 1, true);
    new DataView(streams.wordDocument.buffer).setUint32(154 + 33 * 8 + 4, table.length, true);
    expect(() =>
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: table, oneTable: streams.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(CorruptFileError);
  });

  it('truncates output when the shared cell allowance is exhausted', () => {
    const streams = makeStreams([{ text: 'A\u0007B\u0007\r', compressed: true }]);
    const budget = new Budget(resolveLimits({ cells: 1 }));
    expect(
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: streams.zeroTable, oneTable: streams.oneTable },
        budget,
      ),
    ).toEqual([{ kind: 'table', rows: [[{ text: 'A' }]] }]);
    expect(budget.truncated).toBe(true);
  });

  it('keeps earlier accepted table cells when the last cell exceeds the allowance', () => {
    const streams = makeStreams([{ text: 'A\u0007B\r', compressed: true }]);
    const budget = new Budget(resolveLimits({ cells: 1 }));
    expect(
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: streams.zeroTable, oneTable: streams.oneTable },
        budget,
      ),
    ).toEqual([{ kind: 'table', rows: [[{ text: 'A' }]] }]);
    expect(budget.truncated).toBe(true);
  });

  it('bounds nested field markers with the shared block-depth limit', () => {
    const streams = makeStreams([
      { text: '\u0013outer\u0013nested\u0013deep\u0014skip\u0015\u0015\u0014ok\u0015\r', compressed: true },
    ]);
    const budget = new Budget(resolveLimits({ blockDepth: 1 }));
    expect(
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: streams.zeroTable, oneTable: streams.oneTable },
        budget,
      ),
    ).toEqual([{ kind: 'paragraph', text: 'ok' }]);
    expect(budget.truncated).toBe(true);
  });

  it('rejects the reserved FcCompressed high bit', () => {
    const streams = makeStreams([{ text: 'safe\r', compressed: true }]);
    const table = streams.zeroTable.slice();
    const fc = new DataView(table.buffer, table.byteOffset, table.byteLength).getUint32(15, true);
    new DataView(table.buffer, table.byteOffset, table.byteLength).setUint32(15, fc | 0x8000_0000, true);
    expect(() =>
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: table, oneTable: streams.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(CorruptFileError);
  });

  it('rejects a malformed FIB, missing CLX, and invalid CLX type', () => {
    const valid = makeStreams([{ text: 'x\r', compressed: true }]);
    const badFib = valid.wordDocument.slice();
    new DataView(badFib.buffer).setUint16(0, 0, true);
    expect(() =>
      parseDocStreams(
        badFib,
        { zeroTable: valid.zeroTable, oneTable: valid.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(CorruptFileError);

    const noClx = valid.wordDocument.slice();
    new DataView(noClx.buffer).setUint32(154 + 33 * 8 + 4, 0, true);
    expect(() =>
      parseDocStreams(
        noClx,
        { zeroTable: valid.zeroTable, oneTable: valid.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(CorruptFileError);

    const badClx = valid.zeroTable.slice();
    badClx[0] = 0x03;
    expect(() =>
      parseDocStreams(
        valid.wordDocument,
        { zeroTable: badClx, oneTable: valid.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(CorruptFileError);
  });

  it('rejects an FIB with an unsupported nFib version below 0x00c1', () => {
    const streams = makeStreams([{ text: 'x\r', compressed: true }], { nFib: 0x00c0 });
    expect(() =>
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: streams.zeroTable, oneTable: streams.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(CorruptFileError);
  });

  it('rejects property records that extend beyond the declared CLX range', () => {
    const streams = makeStreams([{ text: 'x\r', compressed: true }]);
    const table = streams.zeroTable.slice();
    table[0] = 0x01;
    new DataView(table.buffer, table.byteOffset, table.byteLength).setUint16(1, table.length, true);
    expect(() =>
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: table, oneTable: streams.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(CorruptFileError);
  });

  it('treats obfuscated FIB files as encrypted', () => {
    const streams = makeStreams([{ text: 'x\r', compressed: true }]);
    new DataView(streams.wordDocument.buffer).setUint16(10, 0x8000, true);
    expect(() =>
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: streams.zeroTable, oneTable: streams.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(EncryptedError);
  });

  it('rejects FIB arrays that cannot contain FibRgLw97 or FibRgFcLcb97', () => {
    const valid = makeStreams([{ text: 'x\r', compressed: true }]);
    const shortLongArray = valid.wordDocument.slice();
    new DataView(shortLongArray.buffer).setUint16(62, 3, true);
    expect(() =>
      parseDocStreams(
        shortLongArray,
        { zeroTable: valid.zeroTable, oneTable: valid.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(CorruptFileError);

    const shortPairArray = valid.wordDocument.slice();
    new DataView(shortPairArray.buffer).setUint16(152, 33, true);
    expect(() =>
      parseDocStreams(
        shortPairArray,
        { zeroTable: valid.zeroTable, oneTable: valid.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(CorruptFileError);
  });

  it('rejects a main-document CP count beyond the final piece boundary', () => {
    const valid = makeStreams([{ text: 'x\r', compressed: true }]);
    new DataView(valid.wordDocument.buffer).setUint32(76, 3, true);
    expect(() =>
      parseDocStreams(
        valid.wordDocument,
        { zeroTable: valid.zeroTable, oneTable: valid.oneTable },
        new Budget(DEFAULT_LIMITS),
      ),
    ).toThrow(CorruptFileError);
  });

  it('closes unterminated field depth after returning available text', () => {
    const streams = makeStreams([{ text: 'Visible\u0013instruction', compressed: true }]);
    const budget = new Budget(DEFAULT_LIMITS);
    expect(
      parseDocStreams(
        streams.wordDocument,
        { zeroTable: streams.zeroTable, oneTable: streams.oneTable },
        budget,
      ),
    ).toEqual([{ kind: 'paragraph', text: 'Visible' }]);
    expect(budget.enterDepth('block')).toBe(true);
    budget.exitDepth('block');
  });
});
