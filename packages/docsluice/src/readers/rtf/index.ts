import type { ListItem, Run } from '../../core/model.js';
import type { Budget } from '../../core/budget.js';
import type { ReadContext, Reader } from '../../core/reader.js';

const MIME = 'application/rtf';
const MAX_RAW_CHUNK = 4096;
const MAX_METADATA_VALUE = 4096;
const MAX_METADATA_FIELDS = 1024;
const MAX_FONTS = 1024;
const MAX_CONTROL_WORD = 64;

interface RtfState {
  pendingDestination: boolean;
  skip: boolean;
  unknownDestination: boolean;
  info: boolean;
  infoField?: string;
  infoValue: string;
  fontTable: boolean;
  fontNumber?: number;
  fontCharset?: number;
  font?: number;
  codePage: number;
  uc: number;
  fallback: number;
  bold: boolean;
  italic: boolean;
  listId?: number;
  listLevel: number;
  bullet?: string;
  heading?: number;
  inTable: boolean;
  headerFooter?: 'header' | 'footer';
  headerText: string;
  pict: boolean;
  object: boolean;
  mergeH: 'start' | 'continue' | undefined;
  mergeV: 'start' | 'continue' | undefined;
}

function initialState(): RtfState {
  return {
    pendingDestination: true,
    skip: false,
    unknownDestination: false,
    info: false,
    infoValue: '',
    fontTable: false,
    codePage: 1252,
    uc: 1,
    fallback: 0,
    bold: false,
    italic: false,
    listLevel: 0,
    inTable: false,
    headerText: '',
    pict: false,
    object: false,
    mergeH: undefined,
    mergeV: undefined,
  };
}

function copyState(state: RtfState): RtfState {
  return { ...state, pendingDestination: true, fallback: 0, infoValue: '' };
}

function isAlpha(byte: number): boolean {
  return (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
}

function isDigit(byte: number): boolean {
  return byte >= 48 && byte <= 57;
}

function hexValueRtf(byte: number): number {
  if (byte >= 48 && byte <= 57) return byte - 48;
  if (byte >= 65 && byte <= 70) return byte - 55;
  if (byte >= 97 && byte <= 102) return byte - 87;
  return -1;
}

function codePageName(codePage: number): string | undefined {
  if (codePage === 932) return 'shift_jis';
  if (codePage === 936) return 'gbk';
  if (codePage === 949) return 'euc-kr';
  if (codePage === 950) return 'big5';
  if (codePage === 65001) return 'utf-8';
  if (codePage >= 1250 && codePage <= 1258) return `windows-${codePage}`;
  if (codePage === 874) return 'windows-874';
  if (codePage === 437) return 'ibm437';
  if (codePage === 850) return 'ibm850';
  return undefined;
}

function charsetCodePage(charset: number): number | undefined {
  switch (charset) {
    case 0:
    case 1:
      return 1252;
    case 2:
      return 42;
    case 77:
      return 10000;
    case 128:
      return 932;
    case 129:
      return 949;
    case 134:
      return 936;
    case 136:
      return 950;
    case 161:
      return 1253;
    case 162:
      return 1254;
    case 163:
      return 1258;
    case 177:
      return 1255;
    case 178:
      return 1256;
    case 186:
      return 1257;
    case 204:
      return 1251;
    case 222:
      return 874;
    case 238:
      return 1250;
    default:
      return undefined;
  }
}

function fieldName(control: string): string | undefined {
  switch (control) {
    case 'title':
    case 'author':
    case 'subject':
    case 'keywords':
    case 'doccomm':
      return control;
    case 'creatim':
      return 'created';
    case 'revtim':
      return 'modified';
    default:
      return undefined;
  }
}

function metadataDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): string | undefined {
  const values = [year, month, day, hour, minute, second];
  if (values.some((value) => !Number.isInteger(value) || value < 0)) return undefined;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
    return undefined;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;
}

/** A bounded, runtime-neutral reader for the textual portion of RTF documents. */
const rtfReader: Reader = {
  id: 'rtf',
  mimeTypes: [MIME],
  detect(bytes) {
    if (bytes.length < 5 || bytes[0] !== 123 || bytes[1] !== 92) return 0;
    return bytes[2] === 114 && bytes[3] === 116 && bytes[4] === 102 ? 1 : 0;
  },
  read(ctx: ReadContext): Promise<void> {
    const { bytes, budget, out, warnings } = ctx;
    const loc = ctx.path ? { path: ctx.path } : {};
    const fonts = new Map<number, number>();
    const metadata: {
      title?: string;
      authors?: string[];
      created?: string;
      modified?: string;
      custom?: Array<{ name: string; value: string }>;
    } = {};
    const stateStack: RtfState[] = [];
    let state = initialState();
    let overflowDepth = 0;
    let groupDepth = 0;
    let index = 0;
    let paragraph = '';
    let paragraphRuns: Run[] = [];
    let pendingChars = 0;
    let stagedDeferredChars = 0;
    let halted = false;
    let textEncoding = 'windows-1252';
    let decoder = new TextDecoder(textEncoding);
    let rawBytes: number[] = [];
    let tableRows: Array<Array<{ text: string; colSpan?: number; rowSpan?: number }>> = [];
    let tableRow: Array<{ text: string; colSpan?: number; rowSpan?: number }> = [];
    let listItems: ListItem[] = [];
    let listLevels: ListItem[][] = [];
    let activeListId: number | undefined;
    let metadataFields = 0;
    const warned = new Set<string>();
    out.setEncoding(textEncoding);

    const warn = (code: 'UNREADABLE_PART' | 'ENCODING_GUESSED'): void => {
      if (warned.has(code)) return;
      warned.add(code);
      warnings.add({
        code,
        message:
          code === 'UNREADABLE_PART'
            ? 'Some RTF content could not be read safely.'
            : 'An unsupported RTF code page was replaced with Windows-1252.',
      });
    };

    const warnDepth = (): void => {
      if (warned.has('DEPTH_LIMIT')) return;
      warned.add('DEPTH_LIMIT');
      warnings.add({ code: 'DEPTH_LIMIT', message: 'Nested RTF groups exceeded the supported depth.' });
    };

    const setEncoding = (codePage: number): void => {
      const mapped = codePageName(codePage);
      if (!mapped) {
        warn('ENCODING_GUESSED');
        textEncoding = 'windows-1252';
        decoder = new TextDecoder(textEncoding);
      } else {
        try {
          decoder = new TextDecoder(mapped);
          textEncoding = mapped;
        } catch {
          warn('ENCODING_GUESSED');
          textEncoding = 'windows-1252';
          decoder = new TextDecoder(textEncoding);
        }
      }
      out.setEncoding(textEncoding);
    };

    const flushRaw = (final: boolean): void => {
      if (rawBytes.length === 0 && !final) return;
      const decoded = decoder.decode(new Uint8Array(rawBytes), { stream: !final });
      rawBytes = [];
      appendText(decoded);
      if (final) decoder = new TextDecoder(textEncoding);
    };

    const appendRun = (text: string): void => {
      if (!text) return;
      paragraph += text;
      pendingChars += text.length;
      if (ctx.options.runs) {
        const last = paragraphRuns[paragraphRuns.length - 1];
        let runText = text;
        if (
          last &&
          (last.bold !== (state.bold || undefined) || last.italic !== (state.italic || undefined))
        ) {
          let trailing = 0;
          while (trailing < last.text.length) {
            const char = last.text[last.text.length - trailing - 1];
            if (char !== ' ' && char !== '\t') break;
            trailing += 1;
          }
          if (trailing > 0) {
            runText = last.text.slice(-trailing) + text;
            last.text = last.text.slice(0, -trailing);
          }
        }
        if (last && last.bold === (state.bold || undefined) && last.italic === (state.italic || undefined)) {
          last.text += runText;
        } else {
          const run: Run = { text: runText };
          if (state.bold) run.bold = true;
          if (state.italic) run.italic = true;
          paragraphRuns.push(run);
        }
      }
    };

    const appendText = (text: string): void => {
      if (!text || halted || state.pict || state.object) return;
      if (state.info && state.infoField) {
        if (state.infoValue.length < MAX_METADATA_VALUE)
          state.infoValue += text.slice(0, MAX_METADATA_VALUE - state.infoValue.length);
        return;
      }
      if (state.skip) return;
      if (state.headerFooter) {
        state.headerText = (state.headerText + text).slice(0, MAX_METADATA_VALUE);
        return;
      }
      if (state.fallback > 0) {
        state.fallback -= 1;
        return;
      }
      const room = Math.max(
        0,
        budget.limits.outputChars - budget.outputChars - pendingChars - stagedDeferredChars,
      );
      if (text.length > room) {
        if (room > 0) appendRun(text.slice(0, room));
        budget.checkOutputChars(budget.limits.outputChars - budget.outputChars + 1);
        halted = true;
        return;
      }
      if (!budget.checkOutputChars(pendingChars + stagedDeferredChars + text.length)) {
        halted = true;
        return;
      }
      appendRun(text);
    };

    const flushParagraph = (): void => {
      if (halted) return;
      const text = paragraph;
      const runs = paragraphRuns;
      paragraph = '';
      paragraphRuns = [];
      pendingChars = 0;
      if (!text.trim()) return;
      if (state.inTable) {
        tableRow.push({ text: text.trim() });
        stagedDeferredChars += text.trim().length;
        return;
      }
      if (state.listId !== undefined) {
        if (activeListId !== state.listId) {
          finishList();
          activeListId = state.listId;
        }
        const item: ListItem = { text: text.trim() };
        stagedDeferredChars += item.text.length;
        if (state.bullet) item.marker = state.bullet;
        const level = Math.max(0, Math.min(state.listLevel, budget.limits.blockDepth - 1));
        if (level === 0 || listLevels.length === 0) {
          listItems.push(item);
          listLevels[0] = listItems;
        } else {
          const parent = listLevels[Math.min(level - 1, listLevels.length - 1)];
          const previous = parent?.at(-1);
          if (previous) {
            previous.items ??= [];
            previous.items.push(item);
            listLevels[level] = previous.items;
          } else {
            listItems.push(item);
            listLevels[0] = listItems;
          }
        }
        listLevels.length = level + 1;
        return;
      }
      finishList();
      if (tableRows.length > 0) finishTable();
      if (state.heading !== undefined) {
        const level = Math.max(1, Math.min(6, state.heading + 1)) as 1 | 2 | 3 | 4 | 5 | 6;
        if (!out.heading(level, text.trim(), loc)) halted = true;
      } else if (!out.paragraph(text.trim(), loc, runs.length > 0 ? runs : undefined)) halted = true;
    };

    function finishList(): void {
      if (listItems.length === 0 || halted) {
        listItems = [];
        listLevels = [];
        activeListId = undefined;
        return;
      }
      if (!out.list(false, listItems, loc)) halted = true;
      stagedDeferredChars = 0;
      listItems = [];
      listLevels = [];
      activeListId = undefined;
    }

    const finishTable = (): void => {
      if (tableRows.length === 0 || halted) {
        tableRows = [];
        return;
      }
      const rows: Array<Array<{ text: string; colSpan?: number; rowSpan?: number }>> = [];
      for (const row of tableRows) {
        budget.tick();
        const cells: Array<{ text: string; colSpan?: number; rowSpan?: number }> = [];
        for (const cell of row) {
          budget.tick();
          cells.push({
            text: cell.text,
            ...(cell.colSpan && cell.colSpan > 1 ? { colSpan: cell.colSpan } : {}),
            ...(cell.rowSpan && cell.rowSpan > 1 ? { rowSpan: cell.rowSpan } : {}),
          });
        }
        rows.push(cells);
      }
      tableRows = [];
      stagedDeferredChars = 0;
      if (!out.table(rows, 0, loc)) halted = true;
    };

    const finishCell = (): void => {
      const text = paragraph.trim();
      stagedDeferredChars += text.length;
      paragraph = '';
      paragraphRuns = [];
      pendingChars = 0;
      if (!budget.addCells(1)) {
        halted = true;
        return;
      }
      const cell: { text: string; colSpan?: number; rowSpan?: number } = { text };
      if (state.mergeH === 'start') cell.colSpan = 2;
      if (state.mergeV === 'start') cell.rowSpan = 2;
      if (state.mergeH !== 'continue' && state.mergeV !== 'continue') tableRow.push(cell);
      state.mergeH = undefined;
      state.mergeV = undefined;
    };

    const finishRow = (): void => {
      if (paragraph.length > 0 || tableRow.length === 0) finishCell();
      if (tableRow.length > 0) tableRows.push(tableRow);
      tableRow = [];
      state.inTable = false;
    };

    const setInfoValue = (field: string, value: string): void => {
      const clean = value.replace(/[\r\n]+/g, ' ').trim();
      if (!clean) return;
      if (metadataFields >= MAX_METADATA_FIELDS) {
        warn('UNREADABLE_PART');
        return;
      }
      metadataFields += 1;
      if (field === 'author') metadata.authors = [...(metadata.authors ?? []), clean];
      else if (field === 'title') metadata.title = clean;
      else if (field === 'created' || field === 'modified') {
        // RTF date fields store numeric components in controls; malformed ones are ignored.
        const pieces = value.match(/\d+/g)?.map(Number) ?? [];
        const result =
          pieces.length >= 6
            ? metadataDate(pieces[0]!, pieces[1]!, pieces[2]!, pieces[3]!, pieces[4]!, pieces[5]!)
            : undefined;
        if (result && field === 'created') metadata.created = result;
        else if (result) metadata.modified = result;
      } else {
        metadata.custom ??= [];
        const name = field === 'doccomm' ? 'comments' : field;
        metadata.custom.push({ name, value: clean });
      }
    };

    const parseControl = (name: string, value: number | undefined, symbol?: number): void => {
      if (symbol !== undefined) {
        if (symbol === 39) {
          const high = hexValue(bytes[index] ?? -1);
          const low = hexValue(bytes[index + 1] ?? -1);
          if (high < 0 || low < 0) warn('UNREADABLE_PART');
          else if (state.fallback > 0) state.fallback -= 1;
          else {
            rawBytes.push((high << 4) | low);
            if (rawBytes.length >= MAX_RAW_CHUNK) flushRaw(false);
          }
          index += Math.min(2, bytes.length - index);
        } else if (symbol === 92 || symbol === 123 || symbol === 125) {
          if (state.fallback > 0) state.fallback -= 1;
          else appendText(String.fromCharCode(symbol));
        } else if (symbol === 126) appendText('\u00a0');
        else if (symbol === 95) appendText('\u2011');
        else if (symbol === 45) {
          // Optional hyphen: it is invisible unless a renderer chooses a break here.
        } else if (symbol === 42) {
          state.unknownDestination = true;
          state.skip = true;
        }
        return;
      }

      if (state.pendingDestination) {
        state.pendingDestination = false;
        if (state.unknownDestination) state.skip = true;
        if (name === 'fonttbl') {
          state.fontTable = true;
          state.skip = true;
        } else if (
          name === 'colortbl' ||
          name === 'stylesheet' ||
          name === 'generator' ||
          name === 'xmlnstbl'
        )
          state.skip = true;
        else if (name === 'info') {
          state.info = true;
          state.skip = true;
        } else if (name === 'pict') {
          state.pict = true;
          flushParagraph();
          if (!out.image({ mimeType: 'image/unknown' }, loc)) halted = true;
        } else if (name === 'object') {
          state.object = true;
          out.setFeature('hasEmbeddedFiles');
        } else if (
          name === 'header' ||
          name === 'headerl' ||
          name === 'headerr' ||
          name === 'footer' ||
          name === 'footerl' ||
          name === 'footerr'
        ) {
          state.headerFooter = name.startsWith('header') ? 'header' : 'footer';
          state.skip = false;
        } else if (state.info) {
          const field = fieldName(name);
          if (field) state.infoField = field;
        }
      }

      // Some producers put the info control directly in the document group and
      // follow it with field groups. Leave that compatibility form on the first
      // non-info control; standards-conforming braced info groups restore state.
      if (
        state.info &&
        !state.infoField &&
        name !== 'info' &&
        !fieldName(name) &&
        !['yr', 'mo', 'dy', 'hr', 'min', 'sec'].includes(name)
      ) {
        state.info = false;
        state.skip = false;
      }

      if (state.fontTable) {
        if (name === 'f' && value !== undefined) state.fontNumber = value;
        if (name === 'fcharset' && value !== undefined) state.fontCharset = value;
        if (
          name === 'f' &&
          value === undefined &&
          state.fontNumber !== undefined &&
          state.fontCharset !== undefined
        ) {
          if (fonts.size < MAX_FONTS) fonts.set(state.fontNumber, state.fontCharset);
          else warn('UNREADABLE_PART');
        }
        return;
      }
      if (state.info && state.infoField) {
        if (name === 'yr' && value !== undefined) state.infoValue += `${value} `;
        else if (value !== undefined && ['mo', 'dy', 'hr', 'min', 'sec'].includes(name))
          state.infoValue += `${value} `;
        return;
      }
      if (name === 'bin') {
        if (value === undefined || value < 0) {
          warn('UNREADABLE_PART');
          return;
        }
        if (value > bytes.length - index) warn('UNREADABLE_PART');
        const amount = Math.min(value, bytes.length - index);
        for (let skipped = 0; skipped < amount; skipped += 4096) budget.tick();
        index += amount;
        return;
      }
      if (state.skip || state.pict || state.object) return;

      switch (name) {
        case 'info':
          state.info = true;
          state.skip = true;
          break;
        case 'ansi':
          state.codePage = 1252;
          setEncoding(state.codePage);
          break;
        case 'mac':
          state.codePage = 10000;
          setEncoding(state.codePage);
          break;
        case 'pc':
          state.codePage = 437;
          setEncoding(state.codePage);
          break;
        case 'ansicpg':
          if (value !== undefined) {
            state.codePage = value;
            setEncoding(value);
          }
          break;
        case 'f':
          if (value !== undefined) {
            state.font = value;
            const charset = fonts.get(value);
            const fontPage = charset === undefined ? undefined : charsetCodePage(charset);
            if (fontPage !== undefined && fontPage !== state.codePage) setEncoding(fontPage);
            else setEncoding(state.codePage);
          }
          break;
        case 'uc':
          if (value !== undefined) state.uc = Math.max(0, Math.min(16, value));
          break;
        case 'u':
          if (value !== undefined) {
            const codeUnit = value < 0 ? value + 65536 : value;
            appendText(String.fromCharCode(codeUnit & 0xffff));
            state.fallback = state.uc;
          }
          break;
        case 'par':
        case 'row':
          if (name === 'row' && state.inTable) finishRow();
          else flushParagraph();
          break;
        case 'line':
          appendText('\n');
          break;
        case 'tab':
          if (!state.bullet) appendText('\t');
          break;
        case 'b':
          state.bold = value !== 0;
          break;
        case 'i':
          state.italic = value !== 0;
          break;
        case 'plain':
          state.bold = false;
          state.italic = false;
          state.font = undefined;
          break;
        case 'pard':
          state.heading = undefined;
          state.listId = undefined;
          state.listLevel = 0;
          state.bullet = undefined;
          break;
        case 'outlinelevel':
          if (value !== undefined) state.heading = value;
          break;
        case 's':
          if (value !== undefined && value >= 1 && value <= 6) state.heading = value - 1;
          break;
        case 'ls':
          if (value !== undefined) state.listId = value;
          break;
        case 'ilvl':
          if (value !== undefined) state.listLevel = value;
          break;
        case 'bullet':
          state.bullet = '•';
          break;
        case 'trowd':
          flushParagraph();
          finishList();
          state.inTable = true;
          break;
        case 'intbl':
          state.inTable = true;
          break;
        case 'cell':
          finishCell();
          break;
        case 'clmgf':
          state.mergeH = 'start';
          break;
        case 'clmrg':
          state.mergeH = 'continue';
          break;
        case 'clvmgf':
          state.mergeV = 'start';
          break;
        case 'clvmrg':
          state.mergeV = 'continue';
          break;
        case 'title':
        case 'author':
        case 'subject':
        case 'keywords':
        case 'doccomm':
        case 'creatim':
        case 'revtim':
          if (state.info) state.infoField = fieldName(name);
          break;
      }
    };

    const hexValue = (byte: number): number => {
      if (byte >= 48 && byte <= 57) return byte - 48;
      if (byte >= 65 && byte <= 70) return byte - 55;
      if (byte >= 97 && byte <= 102) return byte - 87;
      return -1;
    };

    const enterGroupDepth = (): boolean => {
      try {
        const allowed = budget.enterDepth('block');
        groupDepth += 1;
        return allowed;
      } catch (error) {
        // enterDepth increments its counter before it checks and throws.
        budget.exitDepth('block');
        throw error;
      }
    };

    const exitGroupDepth = (): void => {
      if (groupDepth === 0) return;
      budget.exitDepth('block');
      groupDepth -= 1;
    };

    try {
      while (index < bytes.length && !halted) {
        budget.tick();
        const byte = bytes[index]!;
        if (overflowDepth > 0) {
          if (byte === 123) {
            enterGroupDepth();
            overflowDepth += 1;
          } else if (byte === 125) {
            overflowDepth -= 1;
            exitGroupDepth();
          } else if (byte === 92) {
            const next = bytes[index + 1];
            if (next !== undefined && isAlpha(next)) {
              let cursor = index + 1;
              let wordLength = 0;
              let name = '';
              while (cursor < bytes.length && isAlpha(bytes[cursor]!)) {
                budget.tick();
                wordLength += 1;
                if (name.length < MAX_CONTROL_WORD) name += String.fromCharCode(bytes[cursor]!);
                cursor += 1;
              }
              if (wordLength > MAX_CONTROL_WORD) warn('UNREADABLE_PART');
              name = name.toLowerCase();
              let sign = 1;
              if (bytes[cursor] === 45) {
                sign = -1;
                cursor += 1;
              }
              let value: number | undefined;
              if (cursor < bytes.length && isDigit(bytes[cursor]!)) {
                value = 0;
                while (cursor < bytes.length && isDigit(bytes[cursor]!)) {
                  budget.tick();
                  value = Math.min(Number.MAX_SAFE_INTEGER, value * 10 + bytes[cursor]! - 48);
                  cursor += 1;
                }
                value *= sign;
              }
              if (bytes[cursor] === 32) cursor += 1;
              index = cursor;
              if (name === 'bin' && value !== undefined && value >= 0) {
                if (value > bytes.length - index) warn('UNREADABLE_PART');
                const amount = Math.min(value, bytes.length - index);
                for (let skipped = 0; skipped < amount; skipped += 4096) budget.tick();
                index += amount;
              }
              continue;
            }
            if (next === 39) index = Math.min(bytes.length, index + 4);
            else index = Math.min(bytes.length, index + 2);
            continue;
          }
          index += 1;
          continue;
        }
        if (byte === 123) {
          flushRaw(true);
          const entered = enterGroupDepth();
          if (!entered || stateStack.length >= budget.limits.blockDepth) {
            warnDepth();
            overflowDepth = 1;
            index += 1;
            continue;
          }
          stateStack.push(state);
          state = copyState(state);
          index += 1;
          continue;
        }
        if (byte === 125) {
          flushRaw(true);
          if (stateStack.length === 0) warn('UNREADABLE_PART');
          else {
            if (state.fontTable && state.fontNumber !== undefined && state.fontCharset !== undefined) {
              if (fonts.size < MAX_FONTS) fonts.set(state.fontNumber, state.fontCharset);
              else warn('UNREADABLE_PART');
            }
            if (state.infoField) setInfoValue(state.infoField, state.infoValue);
            if (state.headerFooter && state.headerText.trim()) {
              if (!out.headerFooter(state.headerFooter, state.headerText.trim(), loc)) halted = true;
            }
            state = stateStack.pop()!;
            exitGroupDepth();
            if (stateStack.length > 0) {
              const selectedPage =
                state.font === undefined
                  ? state.codePage
                  : (charsetCodePage(fonts.get(state.font) ?? -1) ?? state.codePage);
              setEncoding(selectedPage);
            }
          }
          index += 1;
          continue;
        }
        if (byte === 92) {
          if (bytes[index + 1] !== 39) flushRaw(true);
          index += 1;
          if (index >= bytes.length) {
            warn('UNREADABLE_PART');
            break;
          }
          const next = bytes[index]!;
          if (isAlpha(next)) {
            let name = '';
            let wordLength = 0;
            while (index < bytes.length && isAlpha(bytes[index]!)) {
              budget.tick();
              wordLength += 1;
              if (name.length < MAX_CONTROL_WORD) name += String.fromCharCode(bytes[index]!);
              index += 1;
            }
            if (wordLength > MAX_CONTROL_WORD) warn('UNREADABLE_PART');
            name = name.toLowerCase();
            let sign = 1;
            if (bytes[index] === 45) {
              sign = -1;
              index += 1;
            }
            let value: number | undefined;
            if (index < bytes.length && isDigit(bytes[index]!)) {
              value = 0;
              while (index < bytes.length && isDigit(bytes[index]!)) {
                budget.tick();
                value = Math.min(Number.MAX_SAFE_INTEGER, value * 10 + bytes[index]! - 48);
                index += 1;
              }
              value *= sign;
            }
            if (bytes[index] === 32) index += 1;
            parseControl(name, value);
          } else {
            index += 1;
            parseControl('', undefined, next);
          }
          continue;
        }
        if (byte === 10 || byte === 13) {
          index += 1;
          continue;
        }
        if (state.fallback > 0) {
          state.fallback -= 1;
          index += 1;
          continue;
        }
        rawBytes.push(byte);
        if (rawBytes.length >= MAX_RAW_CHUNK) flushRaw(false);
        index += 1;
      }

      flushRaw(true);
      if (overflowDepth > 0 || stateStack.length > 0) warn('UNREADABLE_PART');
      if (
        metadata.title ||
        metadata.authors ||
        metadata.created ||
        metadata.modified ||
        metadata.custom?.length
      )
        out.setMetadata(metadata);
      if (!halted) {
        flushParagraph();
        finishList();
        if (tableRow.length > 0) finishRow();
        finishTable();
      }
    } finally {
      while (groupDepth > 0) exitGroupDepth();
    }
    return Promise.resolve();
  },
};

export default rtfReader;
export { rtfReader };

/**
 * Extracts an MS-OXRTFEX HTML/plain-text view when the first RTF tokens mark
 * the document as HTML. Returns undefined for ordinary RTF or when a shared
 * budget prevents safe completion.
 */
export function deencapsulateRtfHtml(bytes: Uint8Array, budget: Budget): string | undefined {
  if (
    bytes.length < 5 ||
    bytes[0] !== 123 ||
    bytes[1] !== 92 ||
    bytes[2] !== 114 ||
    bytes[3] !== 116 ||
    bytes[4] !== 102
  )
    return undefined;

  let cursor = 1;
  let tokens = 1;
  let recognized = false;
  while (cursor < bytes.length && tokens < 10) {
    budget.tick();
    const byte = bytes[cursor]!;
    if (byte === 123) {
      tokens += 1;
      cursor += 1;
      continue;
    }
    if (byte !== 92) return undefined;
    cursor += 1;
    if (cursor >= bytes.length || !isAlpha(bytes[cursor]!)) return undefined;
    let name = '';
    while (cursor < bytes.length && isAlpha(bytes[cursor]!)) {
      budget.tick();
      if (name.length < MAX_CONTROL_WORD) name += String.fromCharCode(bytes[cursor]!);
      cursor += 1;
    }
    while (cursor < bytes.length && isDigit(bytes[cursor]!)) {
      budget.tick();
      cursor += 1;
    }
    if (bytes[cursor] === 45) cursor += 1;
    if (bytes[cursor] === 32) cursor += 1;
    tokens += 1;
    if (name.toLowerCase() === 'fromhtml') {
      recognized = true;
      break;
    }
    if (name.toLowerCase() === 'fromtext') return undefined;
  }
  if (!recognized) return undefined;

  interface HtmlState {
    pendingDestination: boolean;
    skip: boolean;
    unknownDestination: boolean;
    htmlTag: boolean;
    mhtmlTag: boolean;
    suppressed: boolean;
    fontTable: boolean;
    fontNumber?: number;
    fontCharset?: number;
    font?: number;
    codePage: number;
    uc: number;
    fallback: number;
  }
  const initial = (): HtmlState => ({
    pendingDestination: true,
    skip: false,
    unknownDestination: false,
    htmlTag: false,
    mhtmlTag: false,
    suppressed: false,
    fontTable: false,
    codePage: 1252,
    uc: 1,
    fallback: 0,
  });
  const clone = (state: HtmlState): HtmlState => ({ ...state, pendingDestination: true, fallback: 0 });
  const stack: HtmlState[] = [];
  const fonts = new Map<number, number>();
  let state = initial();
  let index = 0;
  let depth = 0;
  let overflowDepth = 0;
  let html = '';
  let raw: number[] = [];
  let encoding = 'windows-1252';
  let decoder = new TextDecoder(encoding);
  let halted = false;
  const output = (text: string): void => {
    if (!text || halted) return;
    if (state.skip || state.mhtmlTag || (!state.htmlTag && state.suppressed)) return;
    if (!budget.checkOutputChars(html.length + text.length)) {
      halted = true;
      return;
    }
    html += text;
  };
  const flush = (): void => {
    if (raw.length === 0) return;
    const text = decoder.decode(new Uint8Array(raw));
    raw = [];
    output(text);
  };
  const selectEncoding = (codePage: number): void => {
    const mapped = codePageName(codePage) ?? 'windows-1252';
    try {
      decoder = new TextDecoder(mapped);
      encoding = mapped;
    } catch {
      encoding = 'windows-1252';
      decoder = new TextDecoder(encoding);
    }
  };
  const currentPage = (): number => {
    if (state.font === undefined) return state.codePage;
    return charsetCodePage(fonts.get(state.font) ?? -1) ?? state.codePage;
  };
  const enterDepth = (): boolean => {
    try {
      const allowed = budget.enterDepth('block');
      depth += 1;
      return allowed;
    } catch (error) {
      budget.exitDepth('block');
      throw error;
    }
  };
  const exitDepth = (): void => {
    if (depth === 0) return;
    budget.exitDepth('block');
    depth -= 1;
  };
  const setPendingDestination = (name: string): void => {
    state.pendingDestination = false;
    if (state.unknownDestination) state.skip = true;
    if (name === 'htmltag') {
      state.htmlTag = true;
      state.skip = false;
      state.mhtmlTag = false;
    } else if (name === 'mhtmltag') {
      state.mhtmlTag = true;
      state.skip = true;
    } else if (name === 'fonttbl') {
      state.fontTable = true;
      state.skip = true;
    } else if (
      name === 'colortbl' ||
      name === 'stylesheet' ||
      name === 'info' ||
      name === 'pict' ||
      name === 'object' ||
      name === 'objdata' ||
      state.unknownDestination
    ) {
      state.skip = true;
    }
  };

  try {
    while (index < bytes.length && !halted) {
      budget.tick();
      const byte = bytes[index]!;
      if (overflowDepth > 0) {
        if (byte === 123) {
          if (!enterDepth()) return undefined;
          overflowDepth += 1;
        } else if (byte === 125) {
          overflowDepth -= 1;
          exitDepth();
        } else if (byte === 92 && bytes[index + 1] === 98) {
          // The general scanner below handles binary runs; overflow mode still
          // recognizes them so a brace in binary data cannot change nesting.
          const match = /^\\bin(\d+) ?/.exec(
            String.fromCharCode(...bytes.subarray(index, Math.min(bytes.length, index + 32))),
          );
          if (match)
            index += Math.min(Number(match[1]), bytes.length - (index + match[0].length)) + match[0].length;
          else index += 1;
        } else if (byte === 92) index += 2;
        else index += 1;
        continue;
      }
      if (byte === 123) {
        flush();
        if (!enterDepth()) return undefined;
        if (stack.length >= budget.limits.blockDepth) {
          overflowDepth = 1;
          index += 1;
          continue;
        }
        stack.push(state);
        state = clone(state);
        index += 1;
        continue;
      }
      if (byte === 125) {
        flush();
        if (state.fontTable && state.fontNumber !== undefined && state.fontCharset !== undefined)
          fonts.set(state.fontNumber, state.fontCharset);
        state = stack.pop() ?? initial();
        if (stack.length > 0) selectEncoding(currentPage());
        exitDepth();
        index += 1;
        continue;
      }
      if (byte !== 92) {
        if (state.fallback > 0) state.fallback -= 1;
        else if (!state.fontTable) raw.push(byte);
        if (raw.length >= MAX_RAW_CHUNK) flush();
        index += 1;
        continue;
      }

      const next = bytes[index + 1];
      if (next === 39) {
        const high = hexValueRtf(bytes[index + 2] ?? -1);
        const low = hexValueRtf(bytes[index + 3] ?? -1);
        if (state.fallback > 0) state.fallback -= 1;
        else if (high >= 0 && low >= 0) {
          raw.push((high << 4) | low);
          if (raw.length >= MAX_RAW_CHUNK) flush();
        }
        index += Math.min(4, bytes.length - index);
        continue;
      }
      flush();
      if (next === 92 || next === 123 || next === 125) {
        if (state.fallback > 0) state.fallback -= 1;
        else output(String.fromCharCode(next));
        index += 2;
        continue;
      }
      if (next === 42) {
        state.unknownDestination = true;
        state.skip = true;
        index += 2;
        continue;
      }
      if (next === 126 || next === 95 || next === 45) {
        if (state.fallback > 0) state.fallback -= 1;
        else if (next !== 45) output(next === 126 ? '\u00a0' : '\u2011');
        index += 2;
        continue;
      }
      if (next === undefined || !isAlpha(next)) {
        index += Math.min(2, bytes.length - index);
        continue;
      }
      let word = '';
      index += 1;
      while (index < bytes.length && isAlpha(bytes[index]!)) {
        budget.tick();
        if (word.length < MAX_CONTROL_WORD) word += String.fromCharCode(bytes[index]!);
        index += 1;
      }
      const name = word.toLowerCase();
      let sign = 1;
      if (bytes[index] === 45) {
        sign = -1;
        index += 1;
      }
      let value: number | undefined;
      if (index < bytes.length && isDigit(bytes[index]!)) {
        value = 0;
        while (index < bytes.length && isDigit(bytes[index]!)) {
          budget.tick();
          value = Math.min(Number.MAX_SAFE_INTEGER, value * 10 + bytes[index]! - 48);
          index += 1;
        }
        value *= sign;
      }
      if (bytes[index] === 32) index += 1;
      if (state.pendingDestination) setPendingDestination(name);
      if (name === 'bin') {
        const amount = Math.min(Math.max(0, value ?? 0), bytes.length - index);
        for (let skipped = 0; skipped < amount; skipped += 4096) budget.tick();
        index += amount;
        continue;
      }
      if (name === 'htmlrtf') state.suppressed = value !== 0;
      else if (name === 'ansi') {
        state.codePage = 1252;
        selectEncoding(state.codePage);
      } else if (name === 'ansicpg' && value !== undefined) {
        state.codePage = value;
        selectEncoding(value);
      } else if (name === 'f' && value !== undefined) {
        if (state.fontTable) state.fontNumber = value;
        else {
          state.font = value;
          selectEncoding(currentPage());
        }
      } else if (name === 'fcharset' && value !== undefined && state.fontTable) {
        state.fontCharset = value;
      } else if (name === 'u' && value !== undefined) {
        const codeUnit = value < 0 ? value + 65536 : value;
        output(String.fromCharCode(codeUnit & 0xffff));
        state.fallback = state.uc;
      } else if (name === 'uc' && value !== undefined) state.uc = Math.max(0, Math.min(16, value));
      else if (name === 'par' || name === 'line') output('\r\n');
      else if (name === 'tab') output('\t');
    }
    flush();
    return halted || depth > 0 || overflowDepth > 0 ? undefined : html;
  } finally {
    while (depth > 0) exitDepth();
  }
}
