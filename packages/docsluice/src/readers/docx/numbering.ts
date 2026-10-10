import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MAX_LEVEL = 8;
/** Real level texts are a few characters; longer ones are cut so markers stay small. */
const MAX_LEVEL_TEXT = 255;

/** One numbering level (`w:lvl`, ECMA-376 Part 1, 17.9.6). */
export interface NumberingLevel {
  numFmt: string;
  lvlText: string;
  start: number;
  /** `w:lvlRestart`: 0 never restarts; n restarts after a level at or above n (1-based) is used. */
  restart?: number;
}

/** A numbering instance (`w:num`) with its abstract levels and per-level overrides. */
export interface NumberingInstance {
  levels: ReadonlyMap<number, NumberingLevel>;
  startOverrides: ReadonlyMap<number, number>;
}

export type DocxNumbering = ReadonlyMap<string, NumberingInstance>;

interface MutableLevel {
  numFmt?: string;
  lvlText?: string;
  start?: number;
  restart?: number;
}

interface Frame {
  localName?: string;
  /** Set on `w:lvl` frames: the level being read. */
  level?: MutableLevel;
}

function wordAttribute(
  attrs: Map<string, string>,
  local: string,
  scopes: readonly Map<string, string>[],
  budget: XmlContext['budget'],
): string | undefined {
  for (const [qualifiedName, value] of attrs) {
    budget.tick();
    const colon = qualifiedName.indexOf(':');
    if (colon < 0 || qualifiedName.slice(colon + 1) !== local) continue;
    const prefix = qualifiedName.slice(0, colon);
    for (let index = scopes.length - 1; index >= 0; index--) {
      budget.tick();
      const uri = scopes[index]!.get(prefix);
      if (uri !== undefined) {
        if (uri === WORD_NS) return value;
        break;
      }
    }
  }
  return undefined;
}

function parseCount(value: string | undefined, budget: XmlContext['budget']): number | undefined {
  if (value === undefined || value.length === 0 || value.length > 6) return undefined;
  let result = 0;
  for (let index = 0; index < value.length; index++) {
    budget.tick();
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    result = result * 10 + code - 48;
  }
  return result;
}

function finishLevel(level: MutableLevel): NumberingLevel {
  const result: NumberingLevel = {
    numFmt: level.numFmt ?? 'decimal',
    lvlText: level.lvlText ?? '',
    start: level.start ?? 1,
  };
  if (level.restart !== undefined) result.restart = level.restart;
  return result;
}

/**
 * Parse numbering.xml with bounded SAX events. Abstract definitions and instances are
 * keyed by their file ids in `Map`s, never in plain objects (SEC-6).
 */
export function parseDocxNumbering(input: Uint8Array | string, ctx: XmlContext): DocxNumbering {
  const abstracts = new Map<string, Map<number, NumberingLevel>>();
  const instances = new Map<
    string,
    { abstractId?: string; levels: Map<number, NumberingLevel>; starts: Map<number, number> }
  >();
  const frames: Frame[] = [];
  const scopes: Map<string, string>[] = [];
  let abstractLevels: Map<number, NumberingLevel> | undefined;
  let instance:
    { abstractId?: string; levels: Map<number, NumberingLevel>; starts: Map<number, number> } | undefined;
  let overrideLevel: number | undefined;
  let levelIndex: number | undefined;

  scanXml(
    input,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        const scope = new Map<string, string>();
        for (const [key, value] of attrs) {
          ctx.budget.tick();
          if (key === 'xmlns') scope.set('', value);
          else if (key.startsWith('xmlns:')) scope.set(key.slice(6), value);
        }
        scopes.push(scope);
        const parent = frames.at(-1)?.localName;
        const local = info.namespaceURI === WORD_NS ? info.localName : undefined;
        const value = (name: string): string | undefined => wordAttribute(attrs, name, scopes, ctx.budget);
        const frame: Frame = { localName: local };
        if (frames.length === 1 && local === 'abstractNum') {
          const id = value('abstractNumId');
          abstractLevels = new Map();
          if (id !== undefined && !abstracts.has(id)) abstracts.set(id, abstractLevels);
        } else if (frames.length === 1 && local === 'num') {
          const id = value('numId');
          instance = { levels: new Map(), starts: new Map() };
          if (id !== undefined && !instances.has(id)) instances.set(id, instance);
        } else if (local === 'abstractNumId' && parent === 'num' && instance) {
          const id = value('val');
          if (id !== undefined) instance.abstractId = id;
        } else if (local === 'lvlOverride' && parent === 'num') {
          overrideLevel = parseCount(value('ilvl'), ctx.budget);
        } else if (local === 'startOverride' && parent === 'lvlOverride' && instance) {
          const start = parseCount(value('val'), ctx.budget);
          if (overrideLevel !== undefined && overrideLevel <= MAX_LEVEL && start !== undefined)
            instance.starts.set(overrideLevel, start);
        } else if (local === 'lvl' && (parent === 'abstractNum' || parent === 'lvlOverride')) {
          levelIndex = parent === 'lvlOverride' ? overrideLevel : parseCount(value('ilvl'), ctx.budget);
          frame.level = {};
        } else if (parent === 'lvl' && frames.at(-1)?.level) {
          const level = frames.at(-1)!.level!;
          if (local === 'start') level.start = parseCount(value('val'), ctx.budget);
          else if (local === 'numFmt') level.numFmt = value('val');
          else if (local === 'lvlText') level.lvlText = value('val')?.slice(0, MAX_LEVEL_TEXT);
          else if (local === 'lvlRestart') level.restart = parseCount(value('val'), ctx.budget);
        }
        frames.push(frame);
      },
      onClose() {
        ctx.budget.tick();
        const frame = frames.pop();
        scopes.pop();
        if (frame?.level && levelIndex !== undefined && levelIndex <= MAX_LEVEL) {
          const parent = frames.at(-1)?.localName;
          const target = parent === 'lvlOverride' ? instance?.levels : abstractLevels;
          if (target && !target.has(levelIndex)) target.set(levelIndex, finishLevel(frame.level));
        }
        if (frame?.localName === 'abstractNum') abstractLevels = undefined;
        if (frame?.localName === 'num') instance = undefined;
        if (frame?.localName === 'lvlOverride') overrideLevel = undefined;
      },
    },
    ctx,
  );

  const result = new Map<string, NumberingInstance>();
  for (const [id, entry] of instances) {
    ctx.budget.tick();
    const base = entry.abstractId === undefined ? undefined : abstracts.get(entry.abstractId);
    if (!base && entry.levels.size === 0) continue;
    const levels = new Map(base ?? []);
    for (const [index, level] of entry.levels) {
      ctx.budget.tick();
      levels.set(index, level);
    }
    result.set(id, { levels, startOverrides: entry.starts });
  }
  return result;
}

const ROMAN: ReadonlyArray<readonly [number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

function roman(value: number): string {
  let rest = value;
  let text = '';
  for (const [amount, symbol] of ROMAN) {
    while (rest >= amount) {
      text += symbol;
      rest -= amount;
    }
  }
  return text;
}

function letters(value: number): string {
  // Word repeats the letter after z: a … z, aa … zz, aaa …
  const letter = String.fromCharCode(97 + ((value - 1) % 26));
  return letter.repeat(Math.floor((value - 1) / 26) + 1);
}

function ordinal(value: number): string {
  const tens = value % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? 'th'
      : value % 10 === 1
        ? 'st'
        : value % 10 === 2
          ? 'nd'
          : value % 10 === 3
            ? 'rd'
            : 'th';
  return `${value}${suffix}`;
}

/** Format one counter in a level's `w:numFmt`. Unknown formats fall back to decimal. */
export function formatNumber(value: number, numFmt: string): string {
  switch (numFmt) {
    case 'none':
    case 'bullet':
      return '';
    case 'decimalZero':
      return value < 10 && value >= 0 ? `0${value}` : String(value);
    case 'lowerLetter':
      return value >= 1 && value <= 780 ? letters(value) : String(value);
    case 'upperLetter':
      return value >= 1 && value <= 780 ? letters(value).toUpperCase() : String(value);
    case 'lowerRoman':
      return value >= 1 && value < 4000 ? roman(value) : String(value);
    case 'upperRoman':
      return value >= 1 && value < 4000 ? roman(value).toUpperCase() : String(value);
    case 'ordinal':
      return value >= 0 ? ordinal(value) : String(value);
    default:
      return String(value);
  }
}

// Symbol and Wingdings bullets are stored in the Unicode private-use area.
const BULLETS = new Map<string, string>([
  ['', '•'],
  ['', '▪'],
  ['', '➢'],
  ['', '✓'],
  ['', '❖'],
  ['', '◦'],
]);

/** Visible marker for a numbered paragraph, composing `%1` … `%9` from the active counters. */
export function listMarker(
  levels: ReadonlyMap<number, NumberingLevel>,
  counters: readonly (number | undefined)[],
  ilvl: number,
  budget: XmlContext['budget'],
): string {
  const level = levels.get(ilvl);
  if (!level) return String(counters[ilvl] ?? 1);
  if (level.numFmt === 'bullet') {
    const text = level.lvlText.trim();
    const mapped = BULLETS.get(text);
    if (mapped !== undefined) return mapped;
    // Other symbol-font glyphs sit in the private-use area and have no portable meaning.
    const code = text.length === 1 ? text.charCodeAt(0) : 0;
    return text.length === 0 || (code >= 0xe000 && code <= 0xf8ff) ? '•' : text;
  }
  let marker = '';
  for (let index = 0; index < level.lvlText.length; index++) {
    budget.tick();
    const character = level.lvlText[index]!;
    const digit = level.lvlText.charCodeAt(index + 1) - 48;
    if (character === '%' && digit >= 1 && digit <= 9) {
      const referenced = levels.get(digit - 1);
      const value = counters[digit - 1] ?? referenced?.start ?? 1;
      marker += formatNumber(value, referenced?.numFmt ?? 'decimal');
      index++;
    } else {
      marker += character;
    }
  }
  return marker;
}

/** Per-`numId` counters that continue across list groups, as Word does. */
export class NumberingCounters {
  readonly #counters = new Map<string, Array<number | undefined>>();

  /** Advance `numId` at `ilvl` and return the counters to format its marker with. */
  next(
    numId: string,
    instance: NumberingInstance,
    ilvl: number,
    budget: XmlContext['budget'],
  ): readonly (number | undefined)[] {
    let counters = this.#counters.get(numId);
    if (!counters) {
      counters = [];
      this.#counters.set(numId, counters);
    }
    const current = counters[ilvl];
    counters[ilvl] =
      current === undefined
        ? (instance.startOverrides.get(ilvl) ?? instance.levels.get(ilvl)?.start ?? 1)
        : current + 1;
    for (let deeper = ilvl + 1; deeper <= MAX_LEVEL; deeper++) {
      budget.tick();
      const restart = instance.levels.get(deeper)?.restart;
      // A deeper level restarts when a higher level is used, unless lvlRestart says otherwise.
      if (restart === undefined || (restart > 0 && ilvl <= restart - 1)) counters[deeper] = undefined;
    }
    return counters;
  }
}
