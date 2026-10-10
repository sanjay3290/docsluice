# LaTeX

The LaTeX reader (`docsluice/latex`, format `latex`, `application/x-latex`) reads `.tex` sources as text with the commands stripped ([ADR 0016](../adr/0016-p2-formats.md), #247). It is a single-pass, hand-written scanner with explicit stacks. Macros are never expanded, nothing is typeset, and no file is included or run (SEC-10, SEC-11).

## Detection

Text is `latex` when it starts with `\documentclass` (or `\documentstyle`), after any `%` comment lines, or when the detection sample contains `\begin{document}`. A `.tex` or `.latex` name, or `application/x-latex`, is a hint as usual. Prose that only mentions `\section` stays text.

## What is read

- **Preamble.** With `\begin{document}`, the text before it is the preamble. Only `\title{…}` (`metadata.title`) and `\author{…}` (`metadata.authors`, split on `\and`, only with `metadata`) are read from it. Text after `\end{document}` is ignored. A fragment without `\begin{document}` is read whole.
- **Headings.** `\part`, `\chapter`, `\section`, `\subsection`, `\subsubsection`, `\paragraph` and `\subparagraph` (starred too) become headings. Levels count from the highest command the document uses. `\maketitle` adds the title as a level-1 heading, and the sections then start at level 2. The `abstract` environment gets an "Abstract" heading.
- **Lists.** `itemize` and `description` are unordered lists, `enumerate` ordered; they nest. `\item[label]` puts the label before the item text.
- **Tables.** `tabular`, `tabular*`, `tabularx`, `longtable` and `array` become tables: `&` separates cells and `\\` ends rows. Rules are dropped. A rule right after the first row makes it a header row. `\caption{…}` is a paragraph.
- **Code.** `verbatim`, `Verbatim`, `lstlisting` and `minted` are code blocks, kept as written. Display math (`\[…\]`, `$$…$$`, `equation`, `align`, `gather`, `multline`, `eqnarray`, `displaymath`, `math`, starred too) are `latex` code blocks.
- **Text.**
  - Inline math (`$…$`, `\(…\)`) is kept as written, without its delimiters.
  - Escapes (`\& \% \$ \# \_ \{ \} \\`) become their characters. `~` and `\,` become spaces, and `\\` is a line break.
  - `%` comments are removed.
  - Blank lines and `\par` end paragraphs.
- **Commands.**
  - Formatting commands keep their argument text: `\textbf{x}`, `\emph{x}`, `\footnote{x}` and unknown commands.
  - `\url{…}` keeps the URL, and `\href{url}{text}` keeps the text.
  - References and settings are dropped with their arguments: `\label`, `\ref`, `\cite…`, `\includegraphics`, `\usepackage`, `\newcommand`, `\vspace`, `\input` and the like.
  - The `comment` environment is dropped.

## Not read

- Accents (`\'e` gives `e`).
- Ligatures and quotes (`--`, ``` `` ``` and `''` stay as written).
- Macro definitions, so `\newcommand{\site}{Plot A}` then `\site` gives nothing.
- Bibliographies, included files, and figures (only their captions).

## Safety

- One pass over the characters; argument scans are bounded by the source.
- Braces and lists nested deeper than `blockDepth` are flattened, with one `DEPTH_LIMIT` warning.
- Unterminated groups, math and environments read to the end of the source.

## Corpus and generators

- `corpus/latex/article.tex` is a hand-made article.
- `scripts/hostile/generate-latex.mjs` writes `hostile/latex`:
  - braces nested 100,000 deep;
  - lists nested 5,000 deep;
  - 200,000 dollar signs;
  - an unterminated verbatim block.
