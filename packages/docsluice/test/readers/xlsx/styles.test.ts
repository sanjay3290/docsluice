import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AbortError } from '../../../src/core/errors.js';
import { Budget } from '../../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { parseXml } from '../../../src/xml/index.js';
import { parseStyles } from '../../../src/readers/xlsx/styles.js';

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const libreOfficeStyles = readFileSync(
  new URL('./fixtures/styles/libreoffice-styles.xml', import.meta.url),
  'utf8',
);

function styles(xml: string) {
  const budget = new Budget(DEFAULT_LIMITS);
  const warnings = new WarningSink();
  const root = parseXml(xml, { budget, warnings });
  return { result: parseStyles(root, budget, warnings), warnings };
}

describe('XLSX styles', () => {
  it('resolves custom and built-in formats in cellXfs order', () => {
    const { result, warnings } = styles(
      `<styleSheet xmlns="${SHEET_NS}">
        <numFmts count="2"><numFmt numFmtId="164" formatCode="0.000"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>
        <cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="2"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs>
      </styleSheet>`,
    );
    expect(result.cellNumFmtIds).toEqual([0, 2, 164, 165]);
    expect([0, 1, 2, 3].map((index) => result.getStyleFormat(index))).toEqual([
      'General',
      '0.00',
      '0.000',
      'yyyy-mm-dd',
    ]);
    expect(warnings.warnings).toHaveLength(0);
  });

  it('reads custom format mappings from a self-authored LibreOffice styles part', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    const warnings = new WarningSink();
    const root = parseXml(libreOfficeStyles, { budget, warnings });
    const result = parseStyles(root, budget, warnings);
    expect(result.cellNumFmtIds).toHaveLength(82);
    expect(result.getStyleFormat(0)).toBe('General');
    expect(result.getStyleFormat(1)).toBe('0');
    expect(result.getStyleFormat(11)).toBe('#,##0');
    expect(result.getStyleFormat(47)).toBe('yyyy-mm-dd');
    expect(warnings.warnings).toHaveLength(0);
  });

  it('inherits number formats from cellStyleXfs only when a cell XF does not apply its own', () => {
    const { result, warnings } = styles(
      `<styleSheet xmlns="${SHEET_NS}">
        <numFmts><numFmt numFmtId="164" formatCode="0.000"/><numFmt numFmtId="165" formatCode="0.0000"/></numFmts>
        <cellStyleXfs><xf numFmtId="14"/><xf numFmtId="165"/><xf numFmtId="165" applyNumberFormat="false"/></cellStyleXfs>
        <cellXfs>
          <xf numFmtId="164" xfId="0" applyNumberFormat="1"/>
          <xf numFmtId="2" xfId="0" applyNumberFormat="false"/>
          <xf numFmtId="164" xfId="1"/>
          <xf xfId="1"/>
          <xf numFmtId="164" xfId="2" applyNumberFormat="false"/>
        </cellXfs>
      </styleSheet>`,
    );
    expect(result.cellNumFmtIds).toEqual([164, 14, 164, 165, 0]);
    expect([0, 1, 2, 3, 4].map((index) => result.getStyleFormat(index))).toEqual([
      '0.000',
      'mm-dd-yy',
      '0.000',
      '0.0000',
      'General',
    ]);
    expect(warnings.warnings).toHaveLength(0);
  });

  it('uses only direct SpreadsheetML children and ignores extension namespace lookalikes', () => {
    const { result, warnings } = styles(
      `<s:styleSheet xmlns:s="${SHEET_NS}" xmlns:e="urn:extension">
        <s:extLst><e:numFmts><e:numFmt numFmtId="164" formatCode="UNTRUSTED"/></e:numFmts></s:extLst>
        <s:numFmts><s:numFmt numFmtId="164" formatCode="0.000"/></s:numFmts>
        <s:cellXfs><s:xf numFmtId="164"/></s:cellXfs>
      </s:styleSheet>`,
    );
    expect(result.getStyleFormat(0)).toBe('0.000');
    expect(warnings.warnings).toHaveLength(0);
  });

  it('returns General for invalid indices and absent style data', () => {
    const { result } = styles(
      `<styleSheet xmlns="${SHEET_NS}"><cellXfs><xf numFmtId="2"/></cellXfs></styleSheet>`,
    );
    expect(result.getStyleFormat(-1)).toBe('General');
    expect(result.getStyleFormat(0.5)).toBe('General');
    expect(result.getStyleFormat(Number.MAX_SAFE_INTEGER)).toBe('General');
    const budget = new Budget(DEFAULT_LIMITS);
    expect(parseStyles(undefined, budget, new WarningSink()).getStyleFormat(0)).toBe('General');
  });

  it('warns once without exposing file data and falls back to General on malformed style records', () => {
    const { result, warnings } = styles(
      `<styleSheet xmlns="${SHEET_NS}">
        <numFmts><numFmt numFmtId="164" formatCode="private-cell-format"/></numFmts>
        <cellXfs><xf numFmtId="164"/><xf numFmtId="not-an-id"/></cellXfs>
      </styleSheet>`,
    );
    expect(result.getStyleFormat(0)).toBe('General');
    expect(result.getStyleFormat(1)).toBe('General');
    expect(warnings.warnings).toHaveLength(1);
    expect(warnings.warnings[0]?.code).toBe('UNREADABLE_PART');
    expect(warnings.warnings[0]?.message).not.toContain('private-cell-format');
  });

  it('falls back only an oversized custom format code without retaining its text', () => {
    const { result, warnings } = styles(
      `<styleSheet xmlns="${SHEET_NS}"><numFmts><numFmt numFmtId="164" formatCode="${'0'.repeat(2049)}"/><numFmt numFmtId="165" formatCode="0.00"/></numFmts><cellXfs><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`,
    );
    expect(result.getStyleFormat(0)).toBe('General');
    expect(result.getStyleFormat(1)).toBe('0.00');
    expect(warnings.warnings).toHaveLength(1);
  });

  it('stops before retaining oversized source trees and propagates cancellation', () => {
    const root = {
      name: 'styleSheet',
      localName: 'styleSheet',
      namespaceURI: SHEET_NS,
      attrs: new Map<string, string>(),
      children: Array.from({ length: 100_001 }, () => ({
        name: 'junk',
        localName: 'junk',
        namespaceURI: SHEET_NS,
        attrs: new Map<string, string>(),
        children: [],
      })),
    };
    const budget = new Budget(DEFAULT_LIMITS);
    const warnings = new WarningSink();
    expect(parseStyles(root, budget, warnings).getStyleFormat(0)).toBe('General');
    expect(warnings.warnings).toHaveLength(1);

    const textRoot = {
      name: 'styleSheet',
      localName: 'styleSheet',
      namespaceURI: SHEET_NS,
      attrs: new Map<string, string>(),
      children: ['x'.repeat(20_000_001)],
    };
    const textWarnings = new WarningSink();
    expect(parseStyles(textRoot, new Budget(DEFAULT_LIMITS), textWarnings).getStyleFormat(0)).toBe('General');
    expect(textWarnings.warnings).toHaveLength(1);

    const controller = new AbortController();
    controller.abort();
    const abortedBudget = new Budget(DEFAULT_LIMITS, { signal: controller.signal });
    expect(() => parseStyles(root, abortedBudget, new WarningSink())).toThrow(AbortError);
  });
});
