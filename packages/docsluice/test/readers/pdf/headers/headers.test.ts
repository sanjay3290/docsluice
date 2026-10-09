import { describe, expect, it } from 'vitest';
import { AbortError, TimeoutError } from '../../../../src/core/errors.js';
import { Budget } from '../../../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../../../src/core/limits.js';
import { WarningSink } from '../../../../src/core/warnings.js';
import type { LayoutLine } from '../../../../src/readers/pdf/layout/layout.js';
import {
  detectRepeatedHeadersFooters,
  type HeaderFooterPage,
} from '../../../../src/readers/pdf/headers/index.js';

const makeBudget = (options: { timeMs?: number; signal?: AbortSignal } = {}) =>
  new Budget(
    { ...DEFAULT_LIMITS, ...(options.timeMs !== undefined ? { timeMs: options.timeMs } : {}) },
    {
      warnings: new WarningSink(),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

function line(text: string, x: number, y: number, sourceIndex = 0, height = 10): LayoutLine {
  return {
    text,
    x,
    y,
    width: Math.max(1, text.length * 5),
    height,
    fontSize: 10,
    dir: 'ltr',
    sourceIndex,
    sourceIndices: [sourceIndex],
    column: -1,
  };
}

function pages(count: number, linesFor: (pageNumber: number) => readonly LayoutLine[]): HeaderFooterPage[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    width: 600,
    height: 800,
    lines: linesFor(index + 1),
  }));
}

describe('private repeated PDF header/footer helper', () => {
  it('removes a digit-varying header on three distinct pages and emits it once', () => {
    const input = pages(3, (pageNumber) => [
      line(`Report ${pageNumber}`, 250, 50),
      line(`Body page ${pageNumber}`, 40, 400, 1),
    ]);
    const result = detectRepeatedHeadersFooters(input, makeBudget());

    expect(result.pages.map(({ lines }) => lines.map(({ text }) => text))).toEqual([
      ['Body page 1'],
      ['Body page 2'],
      ['Body page 3'],
    ]);
    expect(result.groups.map(({ role, text, pageIndices }) => ({ role, text, pageIndices }))).toEqual([
      { role: 'header', text: 'Report 1', pageIndices: [0, 1, 2] },
    ]);
  });

  it('classifies a digit-varying page number in the bottom footer band', () => {
    const input = pages(3, (pageNumber) => [line(`Page ${pageNumber} of 3`, 250, 775)]);
    const result = detectRepeatedHeadersFooters(input, makeBudget());
    expect(result.pages.map(({ lines }) => lines)).toEqual([[], [], []]);
    expect(
      result.groups.map(({ role, text, normalizedText, pageIndices }) => ({
        role,
        text,
        normalizedText,
        pageIndices,
      })),
    ).toEqual([
      { role: 'footer', text: 'Page 1 of 3', normalizedText: 'Page # of #', pageIndices: [0, 1, 2] },
    ]);
  });

  it('does not classify repeated text on only two pages', () => {
    const input = pages(2, () => [line('Report', 250, 50), line('Footer', 250, 770, 1)]);
    const result = detectRepeatedHeadersFooters(input, makeBudget());
    expect(result.pages.map(({ lines }) => lines)).toEqual(input.map(({ lines }) => lines));
    expect(result.groups).toEqual([]);
  });

  it('uses the exact three-of-five threshold and preserves candidates below it', () => {
    const input = pages(5, (pageNumber) => [
      ...(pageNumber <= 3 ? [line('Common header', 250, 50)] : []),
      ...(pageNumber <= 2 ? [line('Rare footer', 250, 770, 1)] : []),
      ...(pageNumber > 3 ? [line(`Body ${pageNumber}`, 40, 400)] : []),
    ]);
    const result = detectRepeatedHeadersFooters(input, makeBudget());
    expect(result.groups.map(({ text, pageIndices }) => ({ text, pageIndices }))).toEqual([
      { text: 'Common header', pageIndices: [0, 1, 2] },
    ]);
    expect(result.pages[0]?.lines.map(({ text }) => text)).toEqual(['Rare footer']);
    expect(result.pages[1]?.lines.map(({ text }) => text)).toEqual(['Rare footer']);
    expect(result.pages[2]?.lines.map(({ text }) => text)).toEqual([]);
    expect(result.pages[0]?.lines).not.toContain(input[0]?.lines[0]);
  });

  it('never removes repeated body text or one-off top-band text', () => {
    const input = pages(6, (pageNumber) => [
      line('Body repeated', 200, 400),
      ...(pageNumber === 1 ? [line('Cover title', 200, 50, 1)] : []),
    ]);
    const result = detectRepeatedHeadersFooters(input, makeBudget());
    expect(result.groups).toEqual([]);
    expect(result.pages.map(({ lines }) => lines)).toEqual(input.map(({ lines }) => lines));
  });

  it('detects alternating odd/even header variants within parity cohorts', () => {
    const input = pages(6, (pageNumber) => [
      line(pageNumber % 2 ? 'Odd issue' : 'Even issue', pageNumber % 2 ? 100 : 400, 50),
      line(`Body ${pageNumber}`, 40, 400, 1),
    ]);
    const result = detectRepeatedHeadersFooters(input, makeBudget());
    expect(result.groups.map(({ text, pageIndices }) => ({ text, pageIndices }))).toEqual([
      { text: 'Odd issue', pageIndices: [0, 2, 4] },
      { text: 'Even issue', pageIndices: [1, 3, 5] },
    ]);
    expect(result.pages.every(({ lines }) => lines.length === 1)).toBe(true);
  });

  it('keeps footer text below the whole-document threshold even when it repeats on odd pages', () => {
    const input = pages(6, (pageNumber) =>
      pageNumber % 2 ? [line('Odd footer', 250, 770)] : [line(`Body ${pageNumber}`, 40, 400)],
    );
    const result = detectRepeatedHeadersFooters(input, makeBudget());
    expect(result.groups).toEqual([]);
    expect(result.pages.map(({ lines }) => lines)).toEqual(input.map(({ lines }) => lines));
  });

  it('does not merge same text at mismatched positions across page and parity thresholds', () => {
    const input = pages(6, (pageNumber) => [
      line('Repeated label', 250, pageNumber <= 3 ? 35 : 80),
      line(`Body ${pageNumber}`, 40, 400, 1),
    ]);
    const result = detectRepeatedHeadersFooters(input, makeBudget());
    expect(result.groups).toEqual([]);
    expect(result.pages.map(({ lines }) => lines[0]?.text)).toEqual(Array(6).fill('Repeated label'));
  });

  it('keeps all page lines and emits no groups in keep mode', () => {
    const input = pages(3, (pageNumber) => [line(`Header ${pageNumber}`, 250, 50)]);
    const result = detectRepeatedHeadersFooters(input, makeBudget(), 'keep');
    expect(result.groups).toEqual([]);
    expect(result.pages.map(({ lines }) => lines)).toEqual(input.map(({ lines }) => lines));
  });

  it('preserves Unicode, surrogate pairs, and original line objects without mutation', () => {
    const original = line('Résumé 😀 \ud800 ٧', 250, 50);
    const input = pages(3, () => [original]);
    const before = JSON.stringify(input);
    const result = detectRepeatedHeadersFooters(input, makeBudget());
    expect(JSON.stringify(input)).toBe(before);
    expect(result.groups[0]?.text).toBe('Résumé 😀 \ud800 ٧');
    expect(result.groups[0]?.normalizedText).toBe('Résumé 😀 \ud800 #');
    expect(result.groups[0]?.normalizedText.includes('\ud800')).toBe(true);
  });

  it('preserves stable group ordering and does not double-charge staged text', () => {
    const input = pages(3, () => [line('Footer', 250, 770), line('Header', 250, 50, 1)]);
    const budget = makeBudget();
    const first = detectRepeatedHeadersFooters(input, budget);
    const second = detectRepeatedHeadersFooters(input, makeBudget());
    expect(first.groups.map(({ role, text }) => [role, text])).toEqual([
      ['header', 'Header'],
      ['footer', 'Footer'],
    ]);
    expect(first).toEqual(second);
    expect(budget.outputChars).toBe(0);
  });

  it('does not consume the shared output-character allowance during classification', () => {
    const limited = new Budget({ ...DEFAULT_LIMITS, outputChars: 20 }, { warnings: new WarningSink() });
    expect(limited.addOutputChars(5)).toBe(true);
    const result = detectRepeatedHeadersFooters(
      pages(3, () => [line('Header', 250, 50)]),
      limited,
    );
    expect(result.groups).toHaveLength(1);
    expect(limited.outputChars).toBe(5);
    expect(limited.warnings.warnings).toEqual([]);
  });

  it('accounts for already charged output before normalizing a candidate', () => {
    const limited = new Budget({ ...DEFAULT_LIMITS, outputChars: 6 }, { warnings: new WarningSink() });
    expect(limited.addOutputChars(5)).toBe(true);
    const input = pages(3, () => [line('H1', 250, 50)]);
    const result = detectRepeatedHeadersFooters(input, limited);
    expect(result.groups).toEqual([]);
    expect(result.pages.map(({ lines }) => lines)).toEqual(input.map(({ lines }) => lines));
    expect(limited.truncated).toBe(true);
    expect(limited.warnings.warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('preflights oversized spans before retaining normalized candidate text', () => {
    const limited = new Budget({ ...DEFAULT_LIMITS, outputChars: 128 }, { warnings: new WarningSink() });
    const oversized = { ...line('X', 250, 50), text: 'X'.repeat(1_000_001) };
    const input = pages(3, () => [oversized]);
    const result = detectRepeatedHeadersFooters(input, limited);
    expect(result.groups).toEqual([]);
    expect(result.pages.map(({ lines }) => lines)).toEqual(input.map(({ lines }) => lines));
    expect(limited.truncated).toBe(true);
    expect(limited.outputChars).toBe(0);
  });

  it('leaves lines unchanged after a prior shared-resource truncation', () => {
    const limited = new Budget({ ...DEFAULT_LIMITS, outputChars: 0 }, { warnings: new WarningSink() });
    expect(limited.addOutputChars(1)).toBe(false);
    const input = pages(3, () => [line('Repeated header', 250, 50)]);
    const result = detectRepeatedHeadersFooters(input, limited);
    expect(result.groups).toEqual([]);
    expect(result.pages.map(({ lines }) => lines)).toEqual(input.map(({ lines }) => lines));
  });

  it('does not scan page lines when the shared child-depth budget is unavailable', () => {
    const rootBudget = new Budget({ ...DEFAULT_LIMITS, childDepth: 0 }, { warnings: new WarningSink() });
    const unavailable = rootBudget.child();
    expect(unavailable.canRead).toBe(false);
    const input = pages(3, () => [line('Repeated header', 250, 50)]);
    const result = detectRepeatedHeadersFooters(input, unavailable);
    expect(result.groups).toEqual([]);
    expect(result.pages.map(({ lines }) => lines)).toEqual(input.map(({ lines }) => lines));
  });

  it('checks caller cancellation while scanning page lines', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      detectRepeatedHeadersFooters(
        pages(3, () => [line('Header', 250, 50)]),
        makeBudget({ signal: controller.signal }),
      ),
    ).toThrow(AbortError);
  });

  it('checks cancellation before an empty keep-mode pass', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => detectRepeatedHeadersFooters([], makeBudget({ signal: controller.signal }), 'keep')).toThrow(
      AbortError,
    );
  });

  it('checks the supplied time budget while scanning', () => {
    expect(() =>
      detectRepeatedHeadersFooters(
        pages(3, () => [line('Header', 250, 50)]),
        makeBudget({ timeMs: 0 }),
      ),
    ).toThrow(TimeoutError);
  });
});
