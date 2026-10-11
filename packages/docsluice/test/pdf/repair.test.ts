import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { rebuildTrailer } from '../../src/readers/pdf/repair.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const rebuilt = (text: string) => {
  const result = rebuildTrailer(bytes(text), new Budget(DEFAULT_LIMITS));
  return result && new TextDecoder().decode(result).slice(text.length);
};

describe('rebuildTrailer', () => {
  it('names the last catalog object in an appended trailer', () => {
    expect(rebuilt('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<<')).toBe(
      '\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
    );
    // An incremental update's newer catalog wins; generations are kept.
    expect(rebuilt('1 0 obj << /Type /Catalog >> endobj 12 3 obj\r<</Type/Catalog>>')).toBe(
      '\ntrailer\n<< /Root 12 3 R >>\n%%EOF\n',
    );
  });

  it('skips a name that only starts with /Catalog and an endobj keyword', () => {
    expect(rebuilt('4 0 obj << /Type /Catalog >> endobj 5 0 obj << /S /CatalogX >> endobj')).toBe(
      '\ntrailer\n<< /Root 4 0 R >>\n%%EOF\n',
    );
  });

  it('gives up without a catalog or an object header', () => {
    expect(rebuilt('%PDF-1.7\n1 0 obj << /Type /Pages >>')).toBeUndefined();
    expect(rebuilt('<< /Type /Catalog >>')).toBeUndefined();
    expect(rebuilt('x obj << /Type /Catalog >>')).toBeUndefined();
    expect(rebuilt('')).toBeUndefined();
  });

  it('leaves the input unchanged and stops when the budget aborts', () => {
    const input = bytes('1 0 obj << /Type /Catalog >>');
    const copy = input.slice();
    rebuildTrailer(input, new Budget(DEFAULT_LIMITS));
    expect(input).toEqual(copy);
    const controller = new AbortController();
    controller.abort();
    expect(() => rebuildTrailer(input, new Budget(DEFAULT_LIMITS, { signal: controller.signal }))).toThrow(
      /abort/i,
    );
  });
});
