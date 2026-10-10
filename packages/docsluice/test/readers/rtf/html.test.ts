import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { resolveLimits } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { deencapsulateRtfHtml } from '../../../src/readers/rtf/index.js';

// RTF sources are written with doubled backslashes, not String.raw: the test transform turns
// `霱` inside some String.raw templates into a character.
const run = (source: string, limits = {}) =>
  deencapsulateRtfHtml(
    new TextEncoder().encode(source),
    new Budget(resolveLimits(limits), { warnings: new WarningSink() }),
  );
const HTML = '{\\rtf1\\fromhtml1 {\\*\\htmltag1}';

describe('RTF-encapsulated HTML control symbols (MS-OXRTFEX)', () => {
  it('writes escaped braces and backslashes, and maps the special spaces and hyphens', () => {
    expect(run(`${HTML}<p>a\\{b\\}c\\\\d\\~e\\_f\\-g</p>}`)).toBe('<p>a{b}c\\d e‑fg</p>');
  });

  it('lets a Unicode fallback consume escaped symbols, hex bytes and plain bytes', () => {
    expect(run(`${HTML}\\u9731\\{x\\u9731\\~y\\u9731\\'41z\\u9731?w\\uc0\\u9731v}`)).toBe('☃x☃y☃z☃w☃v');
  });

  it('skips unknown control symbols and reads negative Unicode values as UTF-16 code units', () => {
    expect(run(`${HTML}a\\|b\\:c\\u-1?d}`)).toBe('abc\uffffd');
  });

  it('skips unknown destinations and their groups', () => {
    expect(run(`${HTML}<b>{\\*\\unknown skipped {nested}}kept</b>}`)).toBe('<b>kept</b>');
  });
});
