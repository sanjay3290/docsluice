import type { Budget } from '../../core/budget.js';
import type { Cell, ListItem } from '../../core/model.js';

/** One block of a LaTeX document, in source order. */
export type LatexBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'code'; text: string; language?: string }
  | { kind: 'table'; rows: Cell[][]; headerRows: number };

export interface LatexDocument {
  blocks: LatexBlock[];
  title?: string;
  authors: string[];
  /** List or group nesting went past `blockDepth`; deeper levels were flattened. */
  depthLimited: boolean;
}

/** Sectioning commands by rank; levels are assigned from the highest rank the document uses. */
const SECTIONS: ReadonlyMap<string, number> = new Map([
  ['part', 0],
  ['chapter', 1],
  ['section', 2],
  ['subsection', 3],
  ['subsubsection', 4],
  ['paragraph', 5],
  ['subparagraph', 6],
]);
/** Commands whose braced arguments are references, files or settings, not reading text. */
const DROPPED: ReadonlySet<string> = new Set([
  'label',
  'ref',
  'eqref',
  'pageref',
  'autoref',
  'cref',
  'Cref',
  'cite',
  'citep',
  'citet',
  'citeauthor',
  'citeyear',
  'nocite',
  'includegraphics',
  'bibliography',
  'bibliographystyle',
  'usepackage',
  'RequirePackage',
  'documentclass',
  'input',
  'include',
  'includeonly',
  'vspace',
  'hspace',
  'setlength',
  'addtolength',
  'setcounter',
  'addtocounter',
  'newcommand',
  'renewcommand',
  'providecommand',
  'newenvironment',
  'renewenvironment',
  'pagestyle',
  'thispagestyle',
  'pagenumbering',
  'date',
  'color',
  'definecolor',
  'graphicspath',
  'hypersetup',
  'cline',
]);
/** Environments whose body is kept verbatim as a code block. */
const VERBATIM: ReadonlySet<string> = new Set([
  'verbatim',
  'verbatim*',
  'Verbatim',
  'lstlisting',
  'minted',
  'comment',
]);
/** Display math environments: kept as written, as a `latex` code block. */
const MATH: ReadonlySet<string> = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'eqnarray',
  'eqnarray*',
  'displaymath',
  'math',
]);
const TABULAR: ReadonlyMap<string, number> = new Map([
  // How many braced arguments come before the rows (the column spec, and a width for tabularx).
  ['tabular', 1],
  ['tabular*', 2],
  ['tabularx', 2],
  ['longtable', 1],
  ['array', 1],
]);
const LISTS: ReadonlySet<string> = new Set(['itemize', 'enumerate', 'description']);
/** Characters a backslash makes literal. */
const ESCAPED: ReadonlySet<string> = new Set(['&', '%', '$', '#', '_', '{', '}', '\\']);

type Group = 'keep' | 'drop' | 'capture';

interface ListFrame {
  ordered: boolean;
  items: ListItem[];
  item: ListItem | undefined;
  text: string;
}

interface TableFrame {
  /** Lists open when the table began; lists opened inside the table take its text first. */
  lists: number;
  /** 1 when a rule (`\\hline`, `\\midrule`) follows the first row. */
  headerRows: number;
  rows: Cell[][];
  row: Cell[];
  cell: string;
}

interface Capture {
  kind: 'heading' | 'title' | 'author' | 'caption';
  rank: number;
  text: string;
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** Collapse whitespace runs to one space and trim, keeping explicit line breaks. */
function tidy(text: string, budget: Budget): string {
  let out = '';
  let space = false;
  for (let index = 0; index < text.length; index++) {
    budget.tick();
    const char = text[index]!;
    if (char === '\n') {
      out = out.trimEnd() + '\n';
      space = false;
      continue;
    }
    if (isSpace(text.charCodeAt(index))) {
      space = out.length > 0 && !out.endsWith('\n');
      continue;
    }
    if (space) out += ' ';
    space = false;
    out += char;
  }
  return out.trim();
}

/**
 * Read a LaTeX source as text: sectioning commands become headings, lists lists, `tabular` tables,
 * verbatim and display math code blocks, and everything else paragraphs with the commands
 * stripped. One pass over the characters with explicit stacks; macros are never expanded and
 * nothing is run. Text before `\begin{document}` is the preamble: only `\title` and `\author` are
 * read from it.
 */
export function parseLatex(source: string, budget: Budget): LatexDocument {
  const result: LatexDocument = { blocks: [], authors: [], depthLimited: false };
  const maxDepth = budget.limits.blockDepth;
  const pending: Array<{ block: LatexBlock; rank?: number }> = [];
  const groups: Group[] = [];
  /** Brace groups opened past the depth limit: their braces still pair, they are just not tracked. */
  let untracked = 0;
  let dropDepth = 0;
  const captures: Array<{ capture: Capture; depth: number }> = [];
  const lists: ListFrame[] = [];
  let table: TableFrame | undefined;
  let paragraph = '';
  const begin = source.indexOf('\\begin{document}');
  let inPreamble = begin >= 0;
  let index = 0;

  const flush = (): void => {
    const text = tidy(paragraph, budget);
    paragraph = '';
    if (text.length > 0) pending.push({ block: { kind: 'paragraph', text } });
  };
  const append = (text: string): void => {
    if (dropDepth > 0) return;
    const capture = captures.at(-1);
    if (capture) {
      capture.capture.text += text;
      return;
    }
    if (inPreamble) return;
    if (table && lists.length <= table.lists) table.cell += text;
    else if (lists.length > 0) lists.at(-1)!.text += text;
    else paragraph += text;
  };
  const finishItem = (frame: ListFrame): void => {
    if (!frame.item) return;
    frame.item.text = tidy(frame.text, budget);
    frame.text = '';
  };
  const closeList = (): void => {
    const frame = lists.pop()!;
    finishItem(frame);
    const parent = lists.at(-1);
    if (frame.items.length === 0) return;
    if (parent?.item) {
      parent.item.items = [...(parent.item.items ?? []), ...frame.items];
    } else if (parent) {
      // Items before the first \item of the outer list: keep them at its level.
      for (const item of frame.items) parent.items.push(item);
    } else {
      pending.push({ block: { kind: 'list', ordered: frame.ordered, items: frame.items } });
    }
  };
  const finishCell = (frame: TableFrame): void => {
    frame.row.push({ text: tidy(frame.cell, budget) });
    frame.cell = '';
  };
  const finishRow = (frame: TableFrame): void => {
    finishCell(frame);
    if (frame.row.some((cell) => cell.text.length > 0)) frame.rows.push(frame.row);
    frame.row = [];
  };
  /** A balanced `{…}` or `[…]` argument starting at `start` (after spaces), or undefined. */
  const argument = (
    start: number,
    open: string,
    close: string,
  ): { text: string; end: number } | undefined => {
    let at = start;
    while (at < source.length && isSpace(source.charCodeAt(at))) {
      budget.tick();
      at++;
    }
    if (source[at] !== open) return undefined;
    let depth = 0;
    for (let cursor = at; cursor < source.length; cursor++) {
      budget.tick();
      const char = source[cursor]!;
      if (char === '\\') cursor++;
      else if (char === open) depth++;
      else if (char === close && --depth === 0)
        return { text: source.slice(at + 1, cursor), end: cursor + 1 };
    }
    return undefined;
  };
  /** Raw text up to `terminator`, or to the end of the source. */
  const rawUntil = (start: number, terminator: string): { text: string; end: number } => {
    const end = source.indexOf(terminator, start);
    return end < 0
      ? { text: source.slice(start), end: source.length }
      : { text: source.slice(start, end), end: end + terminator.length };
  };
  const openGroup = (group: Group): void => {
    if (groups.length >= maxDepth) {
      result.depthLimited = true;
      untracked++;
      return;
    }
    groups.push(group);
    if (group === 'drop') dropDepth++;
  };
  const closeGroup = (): void => {
    if (untracked > 0) {
      untracked--;
      return;
    }
    const group = groups.pop();
    if (group === 'drop') dropDepth--;
    const capture = captures.at(-1);
    if (group === 'capture' && capture && capture.depth === groups.length) {
      captures.pop();
      const text = tidy(capture.capture.text, budget);
      if (capture.capture.kind === 'title') {
        if (text) result.title = text;
      } else if (capture.capture.kind === 'author') {
        for (const author of text.split('\n')) {
          budget.tick();
          const name = author.trim();
          if (name) result.authors.push(name);
        }
      } else if (!inPreamble && dropDepth === 0 && text) {
        if (capture.capture.kind === 'heading') {
          if (lists.length === 0 && !table) {
            flush();
            pending.push({ block: { kind: 'heading', level: 0, text }, rank: capture.capture.rank });
          } else append(` ${text} `);
        } else {
          flush();
          pending.push({ block: { kind: 'paragraph', text } });
        }
      }
    }
  };
  /** After a command: skip `[…]` options, then open `count` braced arguments in the given modes. */
  const commandArguments = (start: number, modes: Group[], capture?: Capture): number => {
    let at = start;
    for (;;) {
      const option = argument(at, '[', ']');
      if (!option) break;
      at = option.end;
    }
    let cursor = at;
    while (cursor < source.length && isSpace(source.charCodeAt(cursor))) cursor++;
    if (source[cursor] !== '{' || modes.length === 0) return at;
    const [first, ...rest] = modes;
    if (rest.length > 0 && first === 'drop') {
      // Leading arguments that are not text (an \href URL): skip them whole.
      const skipped = argument(cursor, '{', '}');
      if (!skipped) return at;
      return commandArguments(skipped.end, rest, capture);
    }
    openGroup(first!);
    if (capture && first === 'capture') captures.push({ capture, depth: groups.length - 1 });
    return cursor + 1;
  };

  while (index < source.length) {
    budget.tick();
    const char = source[index]!;
    if (char === '%') {
      // A comment runs to the end of the line, and eats the line break and the next line's indent.
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end + 1;
      while (index < source.length && (source[index] === ' ' || source[index] === '\t')) index++;
      continue;
    }
    if (char === '{') {
      openGroup('keep');
      index++;
      continue;
    }
    if (char === '}') {
      closeGroup();
      index++;
      continue;
    }
    if (char === '~') {
      append(' ');
      index++;
      continue;
    }
    if (char === '&' && table && dropDepth === 0 && captures.length === 0) {
      finishCell(table);
      index++;
      continue;
    }
    if (char === '$') {
      // Inline math is kept as written; $$…$$ is display math.
      if (source[index + 1] === '$') {
        const math = rawUntil(index + 2, '$$');
        if (!inPreamble && dropDepth === 0) {
          flush();
          pending.push({ block: { kind: 'code', text: math.text.trim(), language: 'latex' } });
        }
        index = math.end;
      } else {
        let end = index + 1;
        while (end < source.length && source[end] !== '$') {
          budget.tick();
          if (source[end] === '\\') end++;
          end++;
        }
        append(source.slice(index + 1, Math.min(end, source.length)));
        index = end + 1;
      }
      continue;
    }
    if (char === '\n') {
      // A blank line ends a paragraph outside lists and tables.
      let next = index + 1;
      while (next < source.length && (source[next] === ' ' || source[next] === '\t' || source[next] === '\r'))
        next++;
      if (source[next] === '\n' && lists.length === 0 && !table && captures.length === 0 && !inPreamble) {
        flush();
        index = next + 1;
        continue;
      }
      append(' ');
      index++;
      continue;
    }
    if (char !== '\\') {
      append(char);
      index++;
      continue;
    }

    // A control sequence: a run of letters, or one other character.
    let end = index + 1;
    while (end < source.length && isLetter(source.charCodeAt(end))) {
      budget.tick();
      end++;
    }
    if (end === index + 1) {
      const symbol = source[index + 1];
      index += 2;
      if (symbol === undefined) break;
      if (symbol === '\\') {
        // A line break; in a table, the end of a row (with an optional [length]).
        const option = argument(index, '[', ']');
        if (option) index = option.end;
        if (table && dropDepth === 0 && captures.length === 0) finishRow(table);
        else append('\n');
      } else if (symbol === '[' || symbol === '(') {
        const close = symbol === '[' ? '\\]' : '\\)';
        const math = rawUntil(index, close);
        if (symbol === '(') append(math.text);
        else if (!inPreamble && dropDepth === 0) {
          flush();
          pending.push({ block: { kind: 'code', text: math.text.trim(), language: 'latex' } });
        }
        index = math.end;
      } else if (ESCAPED.has(symbol)) {
        append(symbol);
      } else if (symbol === ',' || symbol === ';' || symbol === ' ' || symbol === ':' || symbol === '!') {
        append(' ');
      }
      // Accents and other symbols (\' \" \^ …) are dropped; their letter follows as text.
      continue;
    }
    let name = source.slice(index + 1, end);
    if (source[end] === '*') {
      name += '*';
      end++;
    }
    index = end;
    const base = name.endsWith('*') ? name.slice(0, -1) : name;

    if (name === 'begin' || name === 'end') {
      const environment = argument(index, '{', '}');
      if (!environment) continue;
      index = environment.end;
      const env = environment.text.trim();
      if (name === 'begin' && !VERBATIM.has(env)) {
        // Placement and other options: \\begin{table}[h], \\begin{enumerate}[a)].
        const option = argument(index, '[', ']');
        if (option) index = option.end;
      }
      if (name === 'begin') {
        if (env === 'document') {
          inPreamble = false;
          continue;
        }
        if (VERBATIM.has(env) || MATH.has(env)) {
          if (env === 'minted') index = argument(index, '{', '}')?.end ?? index;
          const body = rawUntil(index, `\\end{${env}}`);
          index = body.end;
          if (!inPreamble && dropDepth === 0 && env !== 'comment') {
            flush();
            const block: LatexBlock = VERBATIM.has(env)
              ? { kind: 'code', text: dropLeadingLineBreak(body.text).trimEnd() }
              : { kind: 'code', text: body.text.trim(), language: 'latex' };
            pending.push({ block });
          }
          continue;
        }
        if (LISTS.has(env)) {
          if (lists.length >= maxDepth) {
            result.depthLimited = true;
            continue;
          }
          if (lists.length === 0) flush();
          lists.push({ ordered: env === 'enumerate', items: [], item: undefined, text: '' });
          continue;
        }
        const specs = TABULAR.get(env);
        if (specs !== undefined && !table) {
          for (let spec = 0; spec < specs; spec++) index = argument(index, '{', '}')?.end ?? index;
          flush();
          table = { lists: lists.length, headerRows: 0, rows: [], row: [], cell: '' };
          continue;
        }
        if (env === 'abstract' && !inPreamble) {
          flush();
          pending.push({ block: { kind: 'heading', level: 0, text: 'Abstract' }, rank: 7 });
        }
        continue;
      }
      if (env === 'document') break;
      if (LISTS.has(env) && lists.length > 0) {
        closeList();
        continue;
      }
      if (TABULAR.has(env) && table) {
        finishRow(table);
        if (table.rows.length > 0 && !inPreamble)
          pending.push({ block: { kind: 'table', rows: table.rows, headerRows: table.headerRows } });
        table = undefined;
      }
      if (env === 'abstract') flush();
      continue;
    }
    if (name === 'item') {
      const frame = lists.at(-1);
      const label = argument(index, '[', ']');
      if (label) index = label.end;
      if (!frame) continue;
      finishItem(frame);
      frame.item = { text: '' };
      frame.items.push(frame.item);
      if (label) frame.text = `${label.text.trim()} `;
      continue;
    }
    if (name === 'par') {
      if (lists.length === 0 && !table && captures.length === 0) flush();
      else append(' ');
      continue;
    }
    if (name === 'hline' || name === 'toprule' || name === 'midrule' || name === 'bottomrule') {
      if (table && table.rows.length === 1 && table.row.length === 0 && table.cell.trim() === '')
        table.headerRows = 1;
      continue;
    }
    if (name === 'and') {
      // Separates authors in \\author.
      append('\n');
      continue;
    }
    if (name === 'footnote') {
      append(' ');
      continue;
    }
    const rank = SECTIONS.get(base);
    if (rank !== undefined) {
      index = commandArguments(index, ['capture'], { kind: 'heading', rank, text: '' });
      continue;
    }
    if (name === 'title' || name === 'author' || name === 'caption') {
      index = commandArguments(index, ['capture'], { kind: name, rank: 0, text: '' });
      continue;
    }
    if (name === 'href') {
      index = commandArguments(index, ['drop', 'keep']);
      continue;
    }
    if (name === 'url') {
      const link = argument(index, '{', '}');
      if (link) {
        append(link.text);
        index = link.end;
      }
      continue;
    }
    if (DROPPED.has(base)) {
      index = commandArguments(index, ['drop']);
      continue;
    }
    if (name === 'maketitle' && result.title !== undefined && !inPreamble) {
      flush();
      pending.push({ block: { kind: 'heading', level: 0, text: result.title }, rank: -1 });
      continue;
    }
    // Any other command: its name goes, its arguments' text stays (\textbf{x}, \emph{x}, \footnote{x}).
  }
  flush();
  while (lists.length > 0) closeList();
  if (table) {
    finishRow(table);
    if (table.rows.length > 0)
      pending.push({ block: { kind: 'table', rows: table.rows, headerRows: table.headerRows } });
  }

  // Heading levels from the highest rank used: a document of \section and \subsection gets 1 and 2.
  // A \maketitle heading is level 1, so sections then start one level below it.
  let top = Number.POSITIVE_INFINITY;
  let titled = false;
  for (const entry of pending) {
    budget.tick();
    if (entry.rank === -1) titled = true;
    else if (entry.rank !== undefined && entry.rank < 7) top = Math.min(top, entry.rank);
  }
  for (const entry of pending) {
    budget.tick();
    if (entry.block.kind === 'heading') {
      const rank = entry.rank ?? 0;
      const level = rank < 0 ? 1 : rank === 7 ? (titled ? 2 : 1) : rank - top + 1 + (titled ? 1 : 0);
      entry.block.level = Math.min(6, Math.max(1, level));
    }
    result.blocks.push(entry.block);
  }
  return result;
}

/** Verbatim bodies start after the line break that ends `\\begin{verbatim}`. */
function dropLeadingLineBreak(text: string): string {
  if (text.startsWith('\r\n')) return text.slice(2);
  return text.startsWith('\n') ? text.slice(1) : text;
}
