import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { extract } from '../../../src/core/extract.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import type { Limits } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { detect } from '../../../src/detect/detect.js';
import { latexReader } from '../../../src/readers/latex/index.js';
import { parseLatex } from '../../../src/readers/latex/parse.js';

const parse = (source: string, limits: Partial<Limits> = {}) =>
  parseLatex(source, new Budget({ ...DEFAULT_LIMITS, ...limits }, { warnings: new WarningSink() }));
const encode = (text: string) => new TextEncoder().encode(text);

describe('LaTeX scanner (#247)', () => {
  it('reads a fragment without a document environment, with escapes and inline math', () => {
    expect(
      parse(String.raw`Costs \& fees: 5\% of \$10, \#1 \_x \{y\} \\ next~line. Inline \(a+b\) and $c$.`)
        .blocks,
    ).toEqual([
      { kind: 'paragraph', text: 'Costs & fees: 5% of $10, #1 _x {y}\nnext line. Inline a+b and c.' },
    ]);
  });

  it('gives heading levels from the highest sectioning command used', () => {
    const result = parse(String.raw`\chapter*{One}\section{Two}\subsubsection{Three}\paragraph{Four}`);
    expect(
      result.blocks.map((block) => (block.kind === 'heading' ? [block.level, block.text] : block.kind)),
    ).toEqual([
      [1, 'One'],
      [2, 'Two'],
      [4, 'Three'],
      [5, 'Four'],
    ]);
  });

  it('keeps display math and verbatim as written, and drops the comment environment', () => {
    const result = parse(
      String.raw`\[ x^2 \] $$ y $$ \begin{align*} a &= b \end{align*} \begin{minted}{js} let x = 1; \end{minted} \begin{comment} hidden \end{comment} end`,
    );
    expect(result.blocks).toEqual([
      { kind: 'code', text: 'x^2', language: 'latex' },
      { kind: 'code', text: 'y', language: 'latex' },
      { kind: 'code', text: 'a &= b', language: 'latex' },
      { kind: 'code', text: ' let x = 1;' },
      { kind: 'paragraph', text: 'end' },
    ]);
  });

  it('nests lists, keeps item labels and text before the first item', () => {
    const result = parse(
      String.raw`\begin{description}stray\item[Term] Meaning \begin{itemize}\begin{itemize}\item deep\end{itemize}\end{itemize}\end{description}`,
    );
    expect(result.blocks).toEqual([
      { kind: 'list', ordered: false, items: [{ text: 'Term Meaning', items: [{ text: 'deep' }] }] },
    ]);
  });

  it('reads tables without rules as headerless, and closes what the source leaves open', () => {
    const result = parse(
      String.raw`\begin{tabularx}{\linewidth}{ll} a & b \\[2pt] c & d \begin{itemize}\item open`,
    );
    expect(result.blocks).toEqual([
      { kind: 'list', ordered: false, items: [{ text: 'open' }] },
      {
        kind: 'table',
        rows: [
          [{ text: 'a' }, { text: 'b' }],
          [{ text: 'c' }, { text: 'd' }],
        ],
        headerRows: 0,
      },
    ]);
  });

  it('drops reference arguments, keeps link text and URLs, and ignores the preamble text', () => {
    const result = parse(
      String.raw`\documentclass{article}\title{T}\author{A}preamble text\begin{document}\url{https://x.invalid} \href{https://y.invalid}{link} \cite[p.~2]{k}\label{l} \includegraphics[width=1cm]{f.png}\end{document}after`,
    );
    expect(result.title).toBe('T');
    expect(result.authors).toEqual(['A']);
    expect(result.blocks).toEqual([{ kind: 'paragraph', text: 'https://x.invalid link' }]);
  });

  it('turns a heading inside a list into item text, and a caption into a paragraph', () => {
    const result = parse(String.raw`\begin{itemize}\item a \section{S}\end{itemize}\caption{C}`);
    expect(result.blocks).toEqual([
      { kind: 'list', ordered: false, items: [{ text: 'a S' }] },
      { kind: 'paragraph', text: 'C' },
    ]);
  });

  it('flattens groups and lists deeper than blockDepth', () => {
    const deep = parse(`${'{'.repeat(50)}x${'}'.repeat(50)}`, { blockDepth: 8 });
    expect(deep.depthLimited).toBe(true);
    expect(deep.blocks).toEqual([{ kind: 'paragraph', text: 'x' }]);
    const lists = parse(String.raw`\begin{itemize}\item a\begin{itemize}\item b\end{itemize}\end{itemize}`, {
      blockDepth: 1,
    });
    expect(lists.depthLimited).toBe(true);
  });

  it('survives unterminated arguments, math and environments', () => {
    for (const source of [
      String.raw`\section{open`,
      String.raw`$x`,
      String.raw`\begin{verbatim} raw`,
      String.raw`\[ x`,
      String.raw`\begin{`,
      '\\',
      String.raw`\item x`,
      '}}}',
    ]) {
      expect(() => parse(source)).not.toThrow();
    }
  });
});

describe('LaTeX reader', () => {
  it('is detected from \\documentclass, comment lines first, or \\begin{document}', async () => {
    expect(latexReader.id).toBe('latex');
    expect((await detect(encode('% header\n%\n\\documentclass{article}\nx'))).format).toBe('latex');
    expect((await detect(encode('Some text\n\\begin{document}\nx'))).format).toBe('latex');
    expect((await detect(encode('% just a comment'))).format).not.toBe('latex');
    expect((await detect(encode('Plain prose about \\section commands.'))).format).toBe('txt');
  });

  it('sets title and authors (authors only with metadata) and warns at the depth limit', async () => {
    const source = encode(
      '\\documentclass{a}\\title{T}\\author{A \\and B}\\begin{document}{{{{x}}}}\\end{document}',
    );
    const doc = await extract(source, { limits: { blockDepth: 2 } });
    expect(doc.format).toBe('latex');
    expect(doc.metadata).toMatchObject({ title: 'T', authors: ['A', 'B'] });
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['DEPTH_LIMIT']);
    expect((await extract(source, { metadata: false })).metadata.authors).toBeUndefined();
  });

  it('stops when the output is full', async () => {
    const doc = await extract(
      encode('\\documentclass{a}\\begin{document}' + 'Paragraph text.\n\n'.repeat(20) + '\\end{document}'),
      {
        limits: { outputChars: 40 },
      },
    );
    expect(doc.stats.truncated).toBe(true);
  });
});
