import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { WarningSink } from '../../src/core/warnings.js';
import { parseDocxStyles } from '../../src/readers/docx/styles.js';

const context = () => ({ budget: new Budget({ ...DEFAULT_LIMITS }), warnings: new WarningSink() });

describe('parseDocxStyles', () => {
  it('finds built-in and localized headings and follows custom basedOn chains', () => {
    const styles = parseDocxStyles(
      `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:style w:type="paragraph" w:styleId="Heading2"/>
        <w:style w:type="paragraph" w:styleId="Titre"><w:name w:val="heading 3"/></w:style>
        <w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
        <w:style w:type="paragraph" w:styleId="Custom"><w:basedOn w:val="Base"/></w:style>
        <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
      </w:styles>`,
      context(),
    );

    expect(styles.get('Heading2')?.level).toBe(2);
    expect(styles.get('Titre')?.level).toBe(3);
    expect(styles.get('Custom')?.level).toBe(3);
    expect(styles.get('Title')?.level).toBe(1);
  });

  it('requires the expected WordprocessingML styles root', () => {
    const ctx = context();
    const styles = parseDocxStyles(
      `<e:styles xmlns:e="urn:extension" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"/></e:styles>`,
      ctx,
    );
    expect(styles.size).toBe(0);
    expect(ctx.warnings.warnings.map((warning) => warning.code)).toContain('UNREADABLE_PART');
  });

  it('guards basedOn cycles and treats file ids as safe Map keys', () => {
    const styles = parseDocxStyles(
      `<s:styles xmlns:s="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <s:style s:type="paragraph" s:styleId="__proto__"><s:basedOn s:val="constructor"/></s:style>
        <s:style s:type="paragraph" s:styleId="constructor"><s:basedOn s:val="__proto__"/></s:style>
      </s:styles>`,
      context(),
    );

    expect(styles.has('__proto__')).toBe(true);
    expect(styles.get('__proto__')?.level).toBeUndefined();
  });

  it('treats outline level 9 as an explicit body-text override', () => {
    const styles = parseDocxStyles(
      `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:style w:type="paragraph" w:styleId="Heading1"/>
        <w:style w:type="paragraph" w:styleId="Body"><w:basedOn w:val="Heading1"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>
      </w:styles>`,
      context(),
    );
    expect(styles.get('Body')?.level).toBeUndefined();
  });

  it('resolves a long basedOn chain with memoized heading levels', () => {
    const definitions = ['<w:style w:type="paragraph" w:styleId="Heading1"/>'];
    for (let index = 0; index < 2_000; index++) {
      const id = `Custom${index}`;
      const parent = index === 0 ? 'Heading1' : `Custom${index - 1}`;
      definitions.push(
        `<w:style w:type="paragraph" w:styleId="${id}"><w:basedOn w:val="${parent}"/></w:style>`,
      );
    }
    const styles = parseDocxStyles(
      `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${definitions.join('')}</w:styles>`,
      context(),
    );
    expect(styles.get('Custom1999')?.level).toBe(1);
  });
});
