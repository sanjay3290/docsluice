import type { Budget } from '../../core/budget.js';
import {
  MAX_CONTROL_WORD,
  MAX_RAW_CHUNK,
  charsetCodePage,
  codePageName,
  hexValueRtf,
  isAlpha,
  isDigit,
} from './common.js';

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
