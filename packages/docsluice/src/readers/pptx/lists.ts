import type { Budget } from '../../core/budget.js';
import type { ListItem } from '../../core/model.js';

/** One list entry before nesting: its level, text and visible marker. */
export interface FlatItem {
  text: string;
  level: number;
  marker?: string;
}

/** Nest flat items by level: an item's parent is the nearest earlier item at a lower level. */
export function nestItems(items: readonly FlatItem[], budget: Budget): ListItem[] {
  const roots: ListItem[] = [];
  const stack: Array<{ level: number; item: ListItem }> = [];
  for (const flat of items) {
    budget.tick();
    const item: ListItem = { text: flat.text };
    if (flat.marker !== undefined && flat.marker.length > 0) item.marker = flat.marker;
    while (stack.length > 0 && stack.at(-1)!.level >= flat.level) {
      budget.tick();
      stack.pop();
    }
    const parent = stack.at(-1)?.item;
    if (parent) (parent.items ??= []).push(item);
    else roots.push(item);
    stack.push({ level: flat.level, item });
  }
  return roots;
}

// Wingdings and Symbol store their glyphs on ordinary letters; these are the common bullet ones.
const SYMBOL_BULLETS = new Map<string, string>([
  ['§', '▪'],
  ['Ø', '➢'],
  ['ü', '✓'],
  ['q', '❑'],
  ['v', '❖'],
  ['n', '■'],
  ['l', '●'],
  ['·', '•'],
]);

/** The visible bullet for `a:buChar`: private-use and symbol-font glyphs become common characters. */
export function bulletMarker(char: string | undefined, symbolFont: boolean): string {
  if (char === undefined || char.length === 0) return '•';
  if (symbolFont) return SYMBOL_BULLETS.get(char) ?? '•';
  const code = char.charCodeAt(0);
  return code >= 0xe000 && code <= 0xf8ff ? '•' : char;
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
  // PowerPoint repeats the letter after z: a … z, aa … zz, aaa …
  const letter = String.fromCharCode(97 + ((value - 1) % 26));
  return letter.repeat(Math.floor((value - 1) / 26) + 1);
}

/**
 * The marker for an `a:buAutoNum` scheme (ECMA-376 Part 1, 20.1.10.61): a base (`arabic`,
 * `alphaLc`, `alphaUc`, `romanLc`, `romanUc`) and a style (`Period`, `ParenR`, `ParenBoth`,
 * `Plain`). Other schemes are shown as `1.`.
 */
export function autoNumberMarker(type: string, value: number): string {
  const bases = ['arabic', 'alphaLc', 'alphaUc', 'romanLc', 'romanUc'] as const;
  const base = bases.find((candidate) => type.startsWith(candidate));
  const style = base === undefined ? 'Period' : type.slice(base.length);
  let number: string;
  if (base === 'alphaLc' || base === 'alphaUc') {
    number = value >= 1 && value <= 780 ? letters(value) : String(value);
    if (base === 'alphaUc') number = number.toUpperCase();
  } else if (base === 'romanLc' || base === 'romanUc') {
    number = value >= 1 && value < 4000 ? roman(value) : String(value);
    if (base === 'romanUc') number = number.toUpperCase();
  } else {
    number = String(value);
  }
  switch (style) {
    case 'ParenR':
      return `${number})`;
    case 'ParenBoth':
      return `(${number})`;
    case 'Plain':
      return number;
    default:
      return `${number}.`;
  }
}
