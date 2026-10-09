import type { Budget } from '../../core/budget.js';
import { CorruptFileError, EncryptedError } from '../../core/errors.js';

export interface DocStreams {
  wordDocument: Uint8Array;
  zeroTable: Uint8Array;
  oneTable: Uint8Array;
}

export type ParsedDocBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'table'; rows: Array<Array<{ text: string }>> };

interface FibInfo {
  encrypted: boolean;
  oneTable: boolean;
  mainCharacters: number;
  clxOffset: number;
  clxLength: number;
  papxOffset: number;
  papxLength: number;
}

interface Range {
  start: number;
  end: number;
}

const corrupt = (): CorruptFileError => new CorruptFileError('The Word document is malformed.');

function checkedRange(bytes: Uint8Array, offset: number, length: number): Range {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.byteLength ||
    length > bytes.byteLength - offset
  ) {
    throw corrupt();
  }
  return { start: offset, end: offset + length };
}

function readFib(wordDocument: Uint8Array): FibInfo {
  checkedRange(wordDocument, 0, 32);
  const view = new DataView(wordDocument.buffer, wordDocument.byteOffset, wordDocument.byteLength);
  if (view.getUint16(0, true) !== 0xa5ec || view.getUint16(2, true) < 0x00c1) throw corrupt();

  const flags = view.getUint16(10, true);
  const wordCountOffset = 32;
  checkedRange(wordDocument, wordCountOffset, 2);
  const wordCount = view.getUint16(wordCountOffset, true);
  const longCountOffset = wordCountOffset + 2 + wordCount * 2;
  checkedRange(wordDocument, longCountOffset, 2);
  const longCount = view.getUint16(longCountOffset, true);
  if (longCount < 4) throw corrupt();
  const longValuesOffset = longCountOffset + 2;
  checkedRange(wordDocument, longValuesOffset, longCount * 4);
  const mainCharacters = view.getUint32(longValuesOffset + 3 * 4, true);
  const pairCountOffset = longValuesOffset + longCount * 4;
  checkedRange(wordDocument, pairCountOffset, 2);
  const pairCount = view.getUint16(pairCountOffset, true);
  if (pairCount < 34) throw corrupt();
  const pairsOffset = pairCountOffset + 2;
  checkedRange(wordDocument, pairsOffset, pairCount * 8);

  return {
    encrypted: (flags & 0x8100) !== 0,
    oneTable: (flags & 0x0200) !== 0,
    mainCharacters,
    clxOffset: view.getUint32(pairsOffset + 33 * 8, true),
    clxLength: view.getUint32(pairsOffset + 33 * 8 + 4, true),
    papxOffset: view.getUint32(pairsOffset + 13 * 8, true),
    papxLength: view.getUint32(pairsOffset + 13 * 8 + 4, true),
  };
}

/** Return the FIB-selected table stream without opening either table stream. */
export function docTableStreamName(wordDocument: Uint8Array): '0Table' | '1Table' {
  const fib = readFib(wordDocument);
  if (fib.encrypted) throw new EncryptedError('unsupported-encryption');
  return fib.oneTable ? '1Table' : '0Table';
}

/** Resolve built-in Heading 1–9 style IDs from the PAPX FKP at a file offset. */
function headingLevelAtFc(
  wordDocument: Uint8Array,
  table: Uint8Array,
  fib: FibInfo,
  fc: number,
  budget: Budget,
): 1 | 2 | 3 | 4 | 5 | 6 | undefined {
  if (fib.papxLength === 0 || fib.papxLength < 4 || (fib.papxLength - 4) % 8 !== 0) {
    return undefined;
  }
  try {
    checkedRange(table, fib.papxOffset, fib.papxLength);
    const tableView = new DataView(table.buffer, table.byteOffset, table.byteLength);
    const count = (fib.papxLength - 4) / 8;
    let low = 0;
    let high = count + 1;
    while (low < high) {
      budget.tick();
      const middle = Math.floor((low + high) / 2);
      const startFc = tableView.getUint32(fib.papxOffset + middle * 4, true);
      if (startFc <= fc) low = middle + 1;
      else high = middle;
    }
    const pageIndex = low - 1;
    if (pageIndex < 0 || pageIndex >= count) return undefined;
    const firstFc = tableView.getUint32(fib.papxOffset + pageIndex * 4, true);
    const nextFc = tableView.getUint32(fib.papxOffset + (pageIndex + 1) * 4, true);
    if (firstFc >= nextFc || fc < firstFc || fc >= nextFc) return undefined;
    const pageNumberOffset = fib.papxOffset + (count + 1) * 4 + pageIndex * 4;
    const pageNumber = tableView.getUint32(pageNumberOffset, true);
    const pageOffset = pageNumber * 512;
    if (!Number.isSafeInteger(pageOffset)) return undefined;
    checkedRange(wordDocument, pageOffset, 512);
    const wordView = new DataView(wordDocument.buffer, wordDocument.byteOffset, wordDocument.byteLength);
    const paragraphs = wordDocument[pageOffset + 511]!;
    if (paragraphs < 1 || paragraphs > 29) return undefined;
    const bxPapOffset = pageOffset + (paragraphs + 1) * 4;
    if (bxPapOffset + paragraphs * 13 > pageOffset + 511) return undefined;
    let lowPapx = 0;
    let highPapx = paragraphs;
    while (lowPapx < highPapx) {
      budget.tick();
      const middle = Math.floor((lowPapx + highPapx) / 2);
      const startFc = wordView.getUint32(pageOffset + middle * 4, true);
      if (startFc <= fc) lowPapx = middle + 1;
      else highPapx = middle;
    }
    const paragraphIndex = lowPapx - 1;
    if (paragraphIndex < 0 || paragraphIndex >= paragraphs) return undefined;
    const firstParagraphFc = wordView.getUint32(pageOffset + paragraphIndex * 4, true);
    const nextParagraphFc = wordView.getUint32(pageOffset + (paragraphIndex + 1) * 4, true);
    if (firstParagraphFc >= nextParagraphFc || fc < firstParagraphFc || fc >= nextParagraphFc) {
      return undefined;
    }
    const papxOffset = pageOffset + wordDocument[bxPapOffset + paragraphIndex * 13]! * 2;
    checkedRange(wordDocument, papxOffset, 2);
    const cb = wordDocument[papxOffset]!;
    const istdOffset = papxOffset + (cb === 0 ? 2 : 1);
    checkedRange(wordDocument, istdOffset, 2);
    const istd = wordView.getUint16(istdOffset, true);
    if (istd < 1 || istd > 9) return undefined;
    return Math.min(istd, 6) as 1 | 2 | 3 | 4 | 5 | 6;
  } catch (error) {
    if (error instanceof CorruptFileError) return undefined;
    throw error;
  }
}

function decodeWindows1252(byte: number): string {
  switch (byte) {
    case 0x80:
      return '\u20ac';
    case 0x82:
      return '\u201a';
    case 0x83:
      return '\u0192';
    case 0x84:
      return '\u201e';
    case 0x85:
      return '\u2026';
    case 0x86:
      return '\u2020';
    case 0x87:
      return '\u2021';
    case 0x88:
      return '\u02c6';
    case 0x89:
      return '\u2030';
    case 0x8a:
      return '\u0160';
    case 0x8b:
      return '\u2039';
    case 0x8c:
      return '\u0152';
    case 0x8e:
      return '\u017d';
    case 0x91:
      return '\u2018';
    case 0x92:
      return '\u2019';
    case 0x93:
      return '\u201c';
    case 0x94:
      return '\u201d';
    case 0x95:
      return '\u2022';
    case 0x96:
      return '\u2013';
    case 0x97:
      return '\u2014';
    case 0x98:
      return '\u02dc';
    case 0x99:
      return '\u2122';
    case 0x9a:
      return '\u0161';
    case 0x9b:
      return '\u203a';
    case 0x9c:
      return '\u0153';
    case 0x9e:
      return '\u017e';
    case 0x9f:
      return '\u0178';
    case 0x81:
    case 0x8d:
    case 0x8f:
    case 0x90:
    case 0x9d:
      return '\ufffd';
    default:
      return String.fromCharCode(byte);
  }
}

function findPcdt(table: Uint8Array, clx: Range, budget: Budget): Range & { plc: Range } {
  let cursor = clx.start;
  let pcdtStart = -1;
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  while (cursor < clx.end) {
    budget.tick();
    const kind = table[cursor]!;
    if (kind === 0x02) {
      pcdtStart = cursor;
      break;
    }
    if (kind !== 0x01) throw corrupt();
    if (cursor > clx.end - 3) throw corrupt();
    checkedRange(table, cursor, 3);
    const prcLength = view.getUint16(cursor + 1, true);
    if (prcLength > clx.end - cursor - 3) throw corrupt();
    checkedRange(table, cursor + 3, prcLength);
    cursor += 3 + prcLength;
  }
  if (pcdtStart < 0) throw corrupt();
  checkedRange(table, pcdtStart, 5);
  const plcLength = view.getUint32(pcdtStart + 1, true);
  const pcdtEnd = pcdtStart + 5 + plcLength;
  checkedRange(table, pcdtStart, 5 + plcLength);
  if (pcdtEnd !== clx.end || plcLength < 4 || (plcLength - 4) % 12 !== 0) throw corrupt();
  return { start: pcdtStart, end: pcdtEnd, plc: { start: pcdtStart + 5, end: pcdtEnd } };
}

function appendText(text: string, amount: number, budget: Budget, append: (text: string) => void): boolean {
  if (!budget.checkOutputChars(amount + text.length)) return false;
  append(text);
  return true;
}

/**
 * Parse the FIB and CLX/PlcPcd text mapping into private staged blocks.
 * The eventual reader adapter owns DocBuilder emission; this function only
 * preflights staged output and never charges output characters itself.
 */
export function parseDocStreams(
  wordDocument: Uint8Array,
  tables: Pick<DocStreams, 'zeroTable' | 'oneTable'>,
  budget: Budget,
): ParsedDocBlock[] {
  budget.tick();
  const fib = readFib(wordDocument);
  if (fib.encrypted) throw new EncryptedError('unsupported-encryption');
  const table = fib.oneTable ? tables.oneTable : tables.zeroTable;
  if (fib.clxLength === 0) throw corrupt();
  const clx = checkedRange(table, fib.clxOffset, fib.clxLength);
  const pcdt = findPcdt(table, clx, budget);
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const plcLength = pcdt.end - pcdt.plc.start;
  const pieceCount = (plcLength - 4) / 12;
  const cpStart = pcdt.plc.start;
  const pcdStart = cpStart + (pieceCount + 1) * 4;

  const blocks: ParsedDocBlock[] = [];
  const fieldResults: boolean[] = [];
  let overflowFields = 0;
  let outputChars = 0;
  let paragraph = '';
  let paragraphStartFc: number | undefined;
  let cell = '';
  let cells: Array<{ text: string }> = [];
  let stopped = false;
  let priorWasCellMark = false;
  let priorCp = -1;
  const wordView = new DataView(wordDocument.buffer, wordDocument.byteOffset, wordDocument.byteLength);
  const flushTableRow = (): void => {
    if (cells.length === 0) return;
    const row: Array<{ text: string }> = [];
    for (const existingCell of cells) {
      budget.tick();
      row.push(existingCell);
    }
    if (cell.length > 0 && !stopped) {
      if (!budget.addCells(1)) stopped = true;
      else row.push({ text: cell });
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'table') last.rows.push(row);
    else blocks.push({ kind: 'table', rows: [row] });
    cells = [];
    cell = '';
    paragraphStartFc = undefined;
  };
  const appendParagraph = (): void => {
    if (cells.length > 0) {
      flushTableRow();
    } else if (paragraph.length > 0) {
      const level =
        paragraphStartFc === undefined
          ? undefined
          : headingLevelAtFc(wordDocument, table, fib, paragraphStartFc, budget);
      if (level === undefined) blocks.push({ kind: 'paragraph', text: paragraph });
      else blocks.push({ kind: 'heading', level, text: paragraph });
      paragraph = '';
      paragraphStartFc = undefined;
    }
  };
  const appendCellText = (text: string): void => {
    cell += text;
  };
  const appendParagraphText = (text: string): void => {
    paragraph += text;
  };

  if (pieceCount === 0 && fib.mainCharacters !== 0) throw corrupt();
  if (view.getInt32(cpStart, true) !== 0) throw corrupt();

  for (let pieceIndex = 0; pieceIndex < pieceCount && !stopped; pieceIndex++) {
    budget.tick();
    const cp = view.getInt32(cpStart + pieceIndex * 4, true);
    const nextCp = view.getInt32(cpStart + (pieceIndex + 1) * 4, true);
    if (cp < 0 || nextCp <= cp || (pieceIndex === 0 ? cp !== 0 : cp !== priorCp)) throw corrupt();
    priorCp = nextCp;
    const pcd = pcdStart + pieceIndex * 8;
    checkedRange(table, pcd, 8);
    const fcCompressed = view.getUint32(pcd + 2, true);
    if ((fcCompressed & 0x8000_0000) !== 0) throw corrupt();
    const compressed = (fcCompressed & 0x4000_0000) !== 0;
    const rawFc = fcCompressed & 0x3fff_ffff;
    const startOffset = compressed ? rawFc / 2 : rawFc;
    const cpLength = nextCp - cp;
    const byteLength = cpLength * (compressed ? 1 : 2);
    checkedRange(wordDocument, startOffset, byteLength);
    if (fib.mainCharacters <= cp) continue;
    const take = Math.min(nextCp, fib.mainCharacters) - cp;
    for (let charIndex = 0; charIndex < take && !stopped; charIndex++) {
      budget.tick();
      const code = compressed
        ? wordDocument[startOffset + charIndex]!
        : wordView.getUint16(startOffset + charIndex * 2, true);
      if (code === 0x13) {
        if (overflowFields > 0) {
          overflowFields++;
        } else {
          if (budget.enterDepth('block')) fieldResults.push(false);
          else {
            budget.exitDepth('block');
            overflowFields = 1;
          }
        }
        continue;
      }
      if (code === 0x14) {
        if (overflowFields === 0 && fieldResults.length > 0) fieldResults[fieldResults.length - 1] = true;
        continue;
      }
      if (code === 0x15) {
        if (overflowFields > 0) overflowFields--;
        else if (fieldResults.length > 0) {
          fieldResults.pop();
          budget.exitDepth('block');
        }
        continue;
      }
      if (overflowFields > 0 || (fieldResults.length > 0 && !fieldResults[fieldResults.length - 1])) continue;
      if (code === 0x0d) {
        appendParagraph();
        priorWasCellMark = false;
        continue;
      }
      if (code === 0x07) {
        if (priorWasCellMark) {
          flushTableRow();
          priorWasCellMark = false;
          continue;
        }
        if (!budget.addCells(1)) {
          stopped = true;
          continue;
        }
        if (cells.length === 0) {
          cells.push({ text: paragraph });
          paragraph = '';
          paragraphStartFc = undefined;
        } else {
          cells.push({ text: cell });
        }
        cell = '';
        priorWasCellMark = true;
        continue;
      }
      priorWasCellMark = false;
      let decoded = '';
      if (compressed) {
        decoded = decodeWindows1252(code);
      } else if (code === 0x09 || code === 0x0a || code >= 0x20) {
        decoded = String.fromCharCode(code);
      }
      if (decoded.length > 0) {
        if (cells.length === 0 && paragraph.length === 0 && paragraphStartFc === undefined) {
          paragraphStartFc = startOffset + charIndex * (compressed ? 1 : 2);
        }
        outputChars += decoded.length;
        if (
          !appendText(
            decoded,
            outputChars - decoded.length,
            budget,
            cells.length > 0 ? appendCellText : appendParagraphText,
          )
        ) {
          outputChars -= decoded.length;
          stopped = true;
        }
      }
    }
  }
  if (!stopped && fib.mainCharacters > (pieceCount === 0 ? 0 : priorCp)) throw corrupt();
  while (fieldResults.length > 0) {
    budget.tick();
    fieldResults.pop();
    budget.exitDepth('block');
  }
  if (paragraph.length > 0 || cells.length > 0) appendParagraph();
  return blocks;
}
