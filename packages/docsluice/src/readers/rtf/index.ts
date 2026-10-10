import type { Cell, ChildDocument, ListItem, Metadata, NoteBlock, Run } from '../../core/model.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import {
  MAX_CONTROL_WORD,
  MAX_FONTS,
  MAX_METADATA_FIELDS,
  MAX_METADATA_VALUE,
  MAX_RAW_CHUNK,
  charsetCodePage,
  codePageName,
  hexValueRtf,
  isAlpha,
  isDigit,
} from './common.js';

export { deencapsulateRtfHtml } from './html.js';

const MIME = 'application/rtf';
/** Text kept for a style name or list label; longer values are cut. */
const MAX_LABEL = 256;
/** Picture bytes are decoded and charged to the uncompressed allowance in chunks of this size. */
const PICTURE_CHUNK = 65_536;

/**
 * Where the text of a group goes. RTF scopes everything to `{...}` groups: a group that opens with a
 * destination control word sends its text there until the group closes.
 */
type Destination =
  | 'body'
  | 'skip'
  | 'fonttbl'
  | 'stylesheet'
  | 'style'
  | 'info'
  | 'infofield'
  | 'header'
  | 'footer'
  | 'footnote'
  | 'annotation'
  | 'atnauthor'
  | 'listtext'
  | 'pict'
  | 'object'
  | 'nesttableprops';

interface Picture {
  chunks: Uint8Array[];
  /** Hex digits not yet paired into bytes. */
  current: number[];
  size: number;
  mimeType?: string;
  extension?: string;
  limited: boolean;
  /** Desired size in twips and scale in percent (`\picwgoal`, `\picscalex`, ...). */
  goal: [width?: number, height?: number];
  scale: [x: number, y: number];
}

/** Text collected for a destination; shared by the destination group and its nested groups. */
interface Story {
  text: string;
  /** Info date components (`\yr`, `\mo`, ...). */
  date?: number[];
  picture?: Picture;
  noteRole?: NoteBlock['role'];
}

interface Group {
  dest: Destination;
  /** The group has just opened, so its first control word may name a destination. */
  first: boolean;
  /** `\*`: an unknown destination in this group is skipped. */
  ignorable: boolean;
  /** The story this group owns; it is finished when the group closes. */
  owns?: Story;
  story?: Story;
  infoField?: string;
  // Character formatting.
  uc: number;
  font?: number;
  bold: boolean;
  italic: boolean;
  hidden: boolean;
  inserted: boolean;
  deleted: boolean;
  // Paragraph formatting (group-scoped in RTF, reset by \pard).
  style?: number;
  outline?: number;
  listId?: number;
  listLevel: number;
  inTable: boolean;
  itap: number;
  // Font and style table entries under construction.
  fontNumber?: number;
  styleNumber?: number;
  styleOutline?: number;
}

interface CellDefinition {
  right: number;
  mergeH?: 'start' | 'continue';
  mergeV?: 'start' | 'continue';
}

type PendingItem =
  | { kind: 'image'; block: Parameters<ReadContext['out']['image']>[0] }
  | { kind: 'note'; note: { role: NoteBlock['role']; text: string; author?: string } };

interface RawRow {
  cells: string[];
  definitions: CellDefinition[];
}

/** Destinations whose content is never document text, whether or not they carry `\*`. */
const SKIPPED_DESTINATIONS = new Set([
  'colortbl',
  'filetbl',
  'listtable',
  'listoverridetable',
  'revtbl',
  'rsidtbl',
  'generator',
  'xmlnstbl',
  'fldinst',
  'themedata',
  'colorschememapping',
  'latentstyles',
  'datastore',
  'mmathpr',
  'pgdsctbl',
  'nonshppict',
  'nonesttables',
  'objdata',
  'objclass',
  'objname',
  'bkmkstart',
  'bkmkend',
  'ftnsep',
  'ftnsepc',
  'aftnsep',
  'aftnsepc',
  'pn',
  'pnseclvl',
  'xe',
  'tc',
  'txe',
  'docvar',
  'userprops',
  'template',
  'private',
  'falt',
  'panose',
  'atnid',
  'atnicn',
  'atrfstart',
  'atrfend',
  'atndate',
  'atntime',
  'atnref',
  'atnparent',
  'background',
  'shpinst',
  'sp',
  'sn',
  'sv',
  'picprop',
  'blipuid',
  'fchars',
  'lchars',
  'printim',
  'buptim',
  'hlinkbase',
  'operator',
  'company',
  'manager',
  'category',
  'comment',
  'nofpages',
  'nofwords',
  'nofchars',
  'edmins',
  'vern',
  'version',
  'id',
]);

const PICTURE_TYPES = new Map([
  ['pngblip', ['image/png', 'png']],
  ['jpegblip', ['image/jpeg', 'jpg']],
  ['emfblip', ['image/emf', 'emf']],
  ['wmetafile', ['image/wmf', 'wmf']],
  ['dibitmap', ['image/bmp', 'bmp']],
  ['wbitmap', ['image/bmp', 'bmp']],
  ['macpict', ['image/pict', 'pict']],
]);

const INFO_FIELDS = new Map([
  ['title', 'title'],
  ['author', 'author'],
  ['subject', 'subject'],
  ['keywords', 'keywords'],
  ['doccomm', 'doccomm'],
  ['creatim', 'created'],
  ['revtim', 'modified'],
]);

const DATE_PARTS = ['yr', 'mo', 'dy', 'hr', 'min', 'sec'];

/** Control words that stand for one character of text. */
const CHARACTER_WORDS = new Map([
  ['line', '\n'],
  ['tab', '\t'],
  ['bullet', '•'],
  ['emdash', '—'],
  ['endash', '–'],
  ['emspace', ' '],
  ['enspace', ' '],
  ['qmspace', ' '],
  ['lquote', '‘'],
  ['rquote', '’'],
  ['ldblquote', '“'],
  ['rdblquote', '”'],
]);

function initialGroup(): Group {
  return {
    dest: 'body',
    first: false,
    ignorable: false,
    uc: 1,
    bold: false,
    italic: false,
    hidden: false,
    inserted: false,
    deleted: false,
    listLevel: 0,
    inTable: false,
    itap: 0,
  };
}

/** A child group inherits all state but owns nothing until it names a destination. */
function childGroup(parent: Group): Group {
  const child: Group = { ...parent, first: true, ignorable: false };
  delete child.owns;
  return child;
}

function metadataDate(parts: readonly number[]): string | undefined {
  const [year = -1, month = -1, day = -1, hour = 0, minute = 0, second = 0] = parts;
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return undefined;
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  if (new Date(time).getUTCDate() !== day) return undefined;
  const pad = (value: number, size: number): string => String(value).padStart(size, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}Z`;
}

/** Symbol-font and middle-dot bullets become the plain bullet the other word-processor readers emit. */
function bulletText(marker: string): string {
  const code = marker.codePointAt(0) ?? 0;
  if (marker.length <= 2 && ((code >= 0xe000 && code <= 0xf8ff) || code === 0xb7)) return '•';
  return marker;
}

/** A label such as `1.`, `a)`, `iv.` or `(3)` marks an ordered list; anything else is a bullet. */
function isOrderedMarker(marker: string): boolean {
  if (marker.length === 0 || marker.length > 8) return false;
  let letters = 0;
  for (let index = 0; index < marker.length; index++) {
    const code = marker.charCodeAt(index);
    if (isDigit(code)) return true;
    if (isAlpha(code)) letters++;
  }
  const last = marker[marker.length - 1];
  return letters > 0 && letters <= 4 && (last === '.' || last === ')');
}

/** `heading N` (any case) names a level-N heading style; returns the zero-based outline level. */
function headingStyleLevel(name: string): number | undefined {
  const clean = name.trim().toLowerCase();
  if (!clean.startsWith('heading ') || clean.length !== 9) return undefined;
  const level = clean.charCodeAt(8) - 48;
  return level >= 1 && level <= 9 ? level - 1 : undefined;
}

function pathWithPrefix(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

/** Turn RTF rows into a full grid: spans from `\cellx` boundaries and merge flags, covered positions empty. */
function tableGrid(rows: readonly RawRow[], ctx: ReadContext): Cell[][] | undefined {
  const boundaries: number[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    for (const definition of row.definitions) {
      ctx.budget.tick();
      if (!seen.has(definition.right)) {
        seen.add(definition.right);
        boundaries.push(definition.right);
      }
    }
  }
  boundaries.sort((left, right) => left - right);
  const grid: Cell[][] = [];
  const vertical: Array<Array<'start' | 'continue' | undefined>> = [];
  for (const row of rows) {
    const cells: Cell[] = [];
    const flags: Array<'start' | 'continue' | undefined> = [];
    let previousRight = Number.NEGATIVE_INFINITY;
    let lastStart: Cell | undefined;
    for (let index = 0; index < row.cells.length; index++) {
      ctx.budget.tick();
      const definition = row.definitions[index];
      let span = 1;
      if (definition && definition.right > previousRight) {
        let covered = 0;
        for (const boundary of boundaries) {
          ctx.budget.tick();
          if (boundary > previousRight && boundary <= definition.right) covered++;
        }
        span = Math.max(1, covered);
        previousRight = definition.right;
      }
      if (definition?.mergeH === 'continue' && lastStart) {
        lastStart.colSpan = (lastStart.colSpan ?? 1) + span;
        for (let copy = 0; copy < span; copy++) {
          cells.push({ text: '' });
          flags.push(undefined);
        }
        continue;
      }
      const cell: Cell = { text: row.cells[index]! };
      if (span > 1) cell.colSpan = span;
      cells.push(cell);
      flags.push(definition?.mergeV);
      for (let copy = 1; copy < span; copy++) {
        cells.push({ text: '' });
        flags.push(undefined);
      }
      lastStart = cell;
    }
    if (!ctx.budget.addCells(cells.length)) return undefined;
    grid.push(cells);
    vertical.push(flags);
  }
  for (let rowIndex = 0; rowIndex < grid.length; rowIndex++) {
    const flags = vertical[rowIndex]!;
    for (let column = 0; column < flags.length; column++) {
      ctx.budget.tick();
      if (flags[column] !== 'start') continue;
      let span = 1;
      while (rowIndex + span < grid.length && vertical[rowIndex + span]![column] === 'continue') {
        ctx.budget.tick();
        const covered = grid[rowIndex + span]![column];
        if (covered) covered.text = '';
        span++;
      }
      if (span > 1) grid[rowIndex]![column]!.rowSpan = span;
    }
  }
  return grid;
}

/** A bounded, runtime-neutral reader for RTF documents. */
export const rtfReader: Reader = {
  id: 'rtf',
  mimeTypes: [MIME, 'text/rtf'],
  async read(ctx: ReadContext): Promise<void> {
    await Promise.resolve();
    readRtf(ctx);
  },
};

function readRtf(ctx: ReadContext): void {
  const { bytes, budget, out, warnings, options } = ctx;
  const loc = ctx.path ? { path: ctx.path } : {};
  const fonts = new Map<number, number>();
  const styles = new Map<number, { level?: number }>();
  const metadata: Metadata = {};
  let metadataFields = 0;
  const warned = new Set<string>();
  const warn = (code: 'UNREADABLE_PART' | 'ENCODING_GUESSED'): void => {
    if (warned.has(code)) return;
    warned.add(code);
    warnings.add({
      code,
      message:
        code === 'UNREADABLE_PART'
          ? 'Some RTF content could not be read safely.'
          : 'An unsupported RTF code page was replaced with Windows-1252.',
    });
  };

  // Decoding: bytes from text and \'hh escapes are decoded with the current font's code page.
  let documentCodePage = 1252;
  let encoding = 'windows-1252';
  let decoder = new TextDecoder(encoding);
  let raw: number[] = [];
  out.setEncoding(encoding);

  // Output state. Text waiting in paragraphs, cells, lists and notes is staged against outputChars.
  let halted = false;
  let staged = 0;
  let paragraph = '';
  let runs: Run[] = [];
  let revisionMark: '' | '+' | '-' = '';
  let revisionsSeen = false;
  let hiddenSeen = false;
  let listMarker: string | undefined;
  let listItems: ListItem[] = [];
  let listLevels: ListItem[][] = [];
  let listOrdered = false;
  let activeList: number | undefined;
  // Images and notes anchored in the current paragraph; once the paragraph closes they wait for its
  // list or table, so they follow the block that holds their anchor.
  let pending: PendingItem[] = [];
  const listHeld: PendingItem[] = [];
  const tableHeld: PendingItem[] = [];
  const footers: string[] = [];
  const headers = new Set<string>();
  let annotationAuthor: string | undefined;
  let pictureCount = 0;

  // Table state: the outer table (\cell, \row) and one level of nesting (\nestcell, \nestrow).
  let rowDefinitions: CellDefinition[] = [];
  let nestedDefinitions: CellDefinition[] = [];
  let pendingMerge: Omit<CellDefinition, 'right'> = {};
  let cellLines: string[] = [];
  let rowCells: string[] = [];
  let tableRows: RawRow[] = [];
  let nestedCellLines: string[] = [];
  let nestedRowCells: string[] = [];
  let nestedRows: RawRow[] = [];
  const nestedTables: Cell[][][] = [];

  const stack: Group[] = [];
  let group = initialGroup();
  let skipFallback = 0;

  const selectCodePage = (codePage: number): void => {
    const name = codePageName(codePage);
    let next = 'windows-1252';
    if (name === undefined) warn('ENCODING_GUESSED');
    else {
      try {
        new TextDecoder(name);
        next = name;
      } catch {
        warn('ENCODING_GUESSED');
      }
    }
    if (next !== encoding) {
      flushRaw();
      encoding = next;
      decoder = new TextDecoder(encoding);
    }
  };
  const setDocumentCodePage = (codePage: number): void => {
    documentCodePage = codePage;
    selectCodePage(fontCodePage(group.font));
    const name = codePageName(codePage);
    let declared = 'windows-1252';
    if (name !== undefined) {
      try {
        new TextDecoder(name);
        declared = name;
      } catch {
        // An unsupported code page keeps the Windows-1252 fallback.
      }
    }
    out.setEncoding(declared);
  };
  const fontCodePage = (font: number | undefined): number => {
    const charset = font === undefined ? undefined : fonts.get(font);
    // Symbol fonts (charset 2) index glyphs, not characters; Windows-1252 keeps their bullets readable.
    if (charset === 2) return 1252;
    return (charset === undefined ? undefined : charsetCodePage(charset)) ?? documentCodePage;
  };

  const stage = (length: number): boolean => {
    if (!budget.checkOutputChars(staged + length)) {
      halted = true;
      return false;
    }
    staged += length;
    return true;
  };
  const unstage = (length: number): void => {
    staged = Math.max(0, staged - length);
  };

  function flushRaw(): void {
    if (raw.length === 0) return;
    const text = decoder.decode(new Uint8Array(raw));
    raw = [];
    emitText(text);
  }

  function appendRun(text: string, bold: boolean, italic: boolean): void {
    if (!options.runs) return;
    const last = runs.at(-1);
    if (last && (last.bold ?? false) === bold && (last.italic ?? false) === italic) {
      last.text += text;
      return;
    }
    // Builder run normalization drops trailing spaces at a formatting change (#204), so a run's
    // trailing spaces move to the start of the next run.
    let moved = text;
    if (last) {
      let trailing = 0;
      while (trailing < last.text.length && last.text[last.text.length - trailing - 1] === ' ') trailing++;
      if (trailing > 0 && trailing < last.text.length) {
        moved = last.text.slice(-trailing) + text;
        last.text = last.text.slice(0, -trailing);
      }
    }
    const run: Run = { text: moved };
    if (bold) run.bold = true;
    if (italic) run.italic = true;
    runs.push(run);
  }

  function appendBody(text: string): void {
    if (options.revisions === 'show') {
      const mark = group.inserted ? '+' : group.deleted ? '-' : '';
      if (mark !== revisionMark) {
        let markers = revisionMark ? `${revisionMark}]` : '';
        if (mark) markers += `[${mark}`;
        revisionMark = mark;
        if (!stage(markers.length)) return;
        paragraph += markers;
        appendRun(markers, false, false);
      }
    }
    if (!stage(text.length)) return;
    paragraph += text;
    appendRun(text, group.bold, group.italic);
  }

  function emitText(text: string): void {
    if (!text || halted) return;
    if (group.hidden && !options.includeHidden) {
      hiddenSeen = true;
      return;
    }
    if (group.inserted || group.deleted) {
      revisionsSeen = true;
      if (options.revisions === 'accept' && group.deleted) return;
      if (options.revisions === 'reject' && group.inserted) return;
    }
    const story = group.story;
    switch (group.dest) {
      case 'body':
        appendBody(text);
        return;
      case 'header':
      case 'footer':
      case 'footnote':
      case 'annotation':
        if (story && stage(text.length)) story.text += text;
        return;
      case 'infofield':
      case 'atnauthor':
        if (story && story.text.length < MAX_METADATA_VALUE)
          story.text += text.slice(0, MAX_METADATA_VALUE - story.text.length);
        return;
      case 'listtext':
      case 'style':
        if (story && story.text.length < MAX_LABEL)
          story.text += text.slice(0, MAX_LABEL - story.text.length);
        return;
      default:
        return;
    }
  }

  function addPictureDigit(value: number): void {
    const picture = group.story?.picture;
    if (!picture || picture.limited) return;
    picture.current.push(value);
    if (picture.current.length >= PICTURE_CHUNK * 2) flushPicture(picture);
  }

  function addPictureBytes(data: Uint8Array): void {
    const picture = group.story?.picture;
    if (!picture || picture.limited || data.length === 0) return;
    flushPicture(picture);
    if (!budget.addUncompressed(data.length)) {
      picture.limited = true;
      return;
    }
    picture.chunks.push(data.slice());
    picture.size += data.length;
  }

  function flushPicture(picture: Picture): void {
    const length = picture.current.length >> 1;
    if (length === 0 || picture.limited) return;
    budget.tick();
    if (!budget.addUncompressed(length)) {
      picture.limited = true;
      picture.current = [];
      return;
    }
    const chunk = new Uint8Array(length);
    for (let index = 0; index < length; index++)
      chunk[index] = (picture.current[index * 2]! << 4) | picture.current[index * 2 + 1]!;
    picture.chunks.push(chunk);
    picture.size += length;
    picture.current = picture.current.length & 1 ? [picture.current.at(-1)!] : [];
  }

  function finishPicture(picture: Picture): void {
    flushPicture(picture);
    const block: Parameters<typeof out.image>[0] = {};
    if (picture.mimeType) block.mimeType = picture.mimeType;
    // Displayed size: twips scaled by percent, at 96 dpi (15 twips per pixel), as DOCX sizes are.
    const [goalWidth, goalHeight] = picture.goal;
    if (goalWidth !== undefined) block.width = Math.max(1, Math.round((goalWidth * picture.scale[0]) / 1500));
    if (goalHeight !== undefined)
      block.height = Math.max(1, Math.round((goalHeight * picture.scale[1]) / 1500));
    if (picture.limited) warn('UNREADABLE_PART');
    else if (picture.size > 0 && options.children !== 'skip') {
      pictureCount++;
      const name = `image${pictureCount}.${picture.extension ?? 'bin'}`;
      const path = pathWithPrefix(ctx.path, name);
      const child: ChildDocument = { path, name, status: 'listed', sizeBytes: picture.size };
      if (picture.mimeType) child.mimeType = picture.mimeType;
      if (options.childBytes) {
        const data = new Uint8Array(picture.size);
        let offset = 0;
        for (const chunk of picture.chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        child.bytes = data;
      }
      out.addChild(child);
      block.ref = path;
    }
    pending.push({ kind: 'image', block });
  }

  function setInfoValue(field: string, story: Story): void {
    if (metadataFields >= MAX_METADATA_FIELDS) {
      warn('UNREADABLE_PART');
      return;
    }
    if (field === 'created' || field === 'modified') {
      const date = metadataDate(story.date ?? []);
      if (!date) return;
      metadataFields++;
      if (field === 'created') metadata.created = date;
      else metadata.modified = date;
      return;
    }
    const clean = story.text.replaceAll('\r', ' ').replaceAll('\n', ' ').trim();
    if (!clean) return;
    metadataFields++;
    if (field === 'author') metadata.authors = [...(metadata.authors ?? []), clean];
    else if (field === 'title') metadata.title = clean;
    else {
      metadata.custom ??= [];
      metadata.custom.push({ name: field === 'doccomm' ? 'comments' : field, value: clean });
    }
  }

  function emitItems(items: PendingItem[]): void {
    for (const item of items) {
      budget.tick();
      if (halted) return;
      if (item.kind === 'image') {
        if (!out.image(item.block, loc)) halted = true;
        continue;
      }
      unstage(item.note.text.length);
      if (!out.note(item.note.role, item.note.text, loc, item.note.author)) halted = true;
    }
  }

  function finishList(): void {
    if (listItems.length > 0 && !halted) {
      let length = 0;
      const items = [...listItems];
      while (items.length > 0) {
        budget.tick();
        const item = items.pop()!;
        length += item.text.length;
        if (item.items) items.push(...item.items);
      }
      unstage(length);
      if (!out.list(listOrdered, listItems, loc)) halted = true;
    }
    listItems = [];
    listLevels = [];
    activeList = undefined;
    emitItems(listHeld.splice(0));
  }

  function finishTable(): void {
    if (cellLines.length > 0 || rowCells.length > 0) finishRow();
    if (tableRows.length === 0) return;
    const rows = tableRows;
    tableRows = [];
    let length = 0;
    for (const row of rows) for (const text of row.cells) length += text.length;
    unstage(length);
    if (halted) return;
    const grid = tableGrid(rows, ctx);
    if (!grid) {
      halted = true;
      return;
    }
    if (!out.table(grid, 0, loc)) {
      halted = true;
      return;
    }
    for (const nested of nestedTables.splice(0)) {
      budget.tick();
      if (!out.table(nested, 0, loc)) {
        halted = true;
        return;
      }
    }
    emitItems(tableHeld.splice(0));
  }

  /** Close the current paragraph. Inside a table it becomes a line of the current cell. */
  function finishParagraph(): void {
    if (revisionMark) {
      const close = `${revisionMark}]`;
      revisionMark = '';
      if (stage(close.length)) {
        paragraph += close;
        appendRun(close, false, false);
      }
    }
    const text = paragraph.trim();
    const paragraphRuns = runs;
    const marker = listMarker;
    const anchored = pending;
    unstage(paragraph.length - text.length);
    paragraph = '';
    runs = [];
    listMarker = undefined;
    pending = [];
    if (halted) return;
    if (group.inTable) {
      finishList();
      tableHeld.push(...anchored);
      if (text) (group.itap >= 2 ? nestedCellLines : cellLines).push(text);
      return;
    }
    finishTable();
    const styleLevel = group.style === undefined ? undefined : styles.get(group.style)?.level;
    const outline = group.outline ?? styleLevel;
    if (outline !== undefined && outline >= 0 && outline <= 8) {
      finishList();
      if (text) {
        unstage(text.length);
        if (!out.heading(Math.min(6, outline + 1) as 1 | 2 | 3 | 4 | 5 | 6, text, loc)) halted = true;
      }
      emitItems(anchored);
      return;
    }
    if (text && (group.listId !== undefined || marker !== undefined)) {
      const id = group.listId ?? -1;
      let itemText = text;
      let itemMarker = marker?.trim() ?? '';
      if (!itemMarker && itemText.startsWith('\u2022')) {
        itemMarker = '\u2022';
        itemText = itemText.slice(1).trim();
        unstage(text.length - itemText.length);
      }
      if (activeList !== id) {
        finishList();
        activeList = id;
        listOrdered = isOrderedMarker(itemMarker);
      }
      const item: ListItem = { text: itemText };
      if (itemMarker) item.marker = bulletText(itemMarker);
      const level = Math.max(0, Math.min(group.listLevel, budget.limits.blockDepth - 1, listLevels.length));
      const parent = level === 0 ? undefined : listLevels[level - 1]?.at(-1);
      if (parent) {
        parent.items ??= [];
        parent.items.push(item);
        listLevels[level] = parent.items;
        listLevels.length = level + 1;
      } else {
        listItems.push(item);
        listLevels = [listItems];
      }
      listHeld.push(...anchored);
      return;
    }
    if (!text && activeList !== undefined && anchored.length === 0) return;
    finishList();
    if (text) {
      unstage(text.length);
      if (!out.paragraph(text, loc, paragraphRuns.length > 0 ? paragraphRuns : undefined)) halted = true;
    }
    emitItems(anchored);
  }

  function finishCell(): void {
    if (paragraph.trim() || pending.length > 0) finishParagraph();
    else paragraph = '';
    if (nestedCellLines.length > 0 || nestedRowCells.length > 0) finishNestedRow();
    if (nestedRows.length > 0) {
      const grid = tableGrid(nestedRows, ctx);
      nestedRows = [];
      if (grid) nestedTables.push(grid);
      else halted = true;
    }
    rowCells.push(cellLines.join('\n'));
    cellLines = [];
  }

  function finishRow(): void {
    if (cellLines.length > 0 || paragraph.trim()) finishCell();
    if (rowCells.length > 0) tableRows.push({ cells: rowCells, definitions: rowDefinitions.slice() });
    rowCells = [];
  }

  function finishNestedCell(): void {
    if (paragraph.trim()) finishParagraph();
    else paragraph = '';
    nestedRowCells.push(nestedCellLines.join('\n'));
    nestedCellLines = [];
  }

  function finishNestedRow(): void {
    if (nestedCellLines.length > 0) finishNestedCell();
    if (nestedRowCells.length === 0) return;
    // The nested row's text also belongs to the outer cell, as in the DOCX and ODT readers.
    for (const text of nestedRowCells) if (text) cellLines.push(text);
    nestedRows.push({ cells: nestedRowCells, definitions: nestedDefinitions.slice() });
    nestedRowCells = [];
  }

  /** A control word that opens a group may name where the group's text goes. */
  function openDestination(name: string): boolean {
    const own = (dest: Destination, story: Story): void => {
      group.dest = dest;
      group.owns = story;
      group.story = story;
    };
    // Inside a skipped destination everything stays skipped, except the Unicode copy of \upr.
    if (group.dest === 'skip' && name !== 'ud') return true;
    switch (name) {
      case 'fonttbl':
      case 'stylesheet':
      case 'info':
      case 'nesttableprops':
        group.dest = name;
        return true;
      case 'header':
      case 'headerl':
      case 'headerr':
      case 'headerf':
        own('header', { text: '' });
        return true;
      case 'footer':
      case 'footerl':
      case 'footerr':
      case 'footerf':
        own('footer', { text: '' });
        return true;
      case 'footnote':
        own('footnote', { text: '', noteRole: 'footnote' });
        return true;
      case 'annotation':
        own('annotation', { text: '', noteRole: 'comment' });
        return true;
      case 'atnauthor':
        own('atnauthor', { text: '' });
        return true;
      case 'listtext':
      case 'pntext':
        own('listtext', { text: '' });
        return true;
      case 'pict':
        own('pict', {
          text: '',
          picture: { chunks: [], current: [], size: 0, limited: false, goal: [], scale: [100, 100] },
        });
        return true;
      case 'object':
        group.dest = 'object';
        out.setFeature('hasEmbeddedFiles');
        return true;
      case 'result':
      case 'fldrslt':
      case 'ud':
        // The rendered result of a field or object, and the Unicode copy inside \upr, are text.
        if (group.dest === 'object' || group.dest === 'skip') group.dest = 'body';
        return true;
      case 'upr':
        // \upr holds an ANSI copy, then {\*\ud ...} with the Unicode copy; only the latter is read.
        group.dest = 'skip';
        return true;
      case 'shppict':
        return true;
      default:
        break;
    }
    // Info fields are read wherever they appear: WordPad-style files put them after an ungrouped \info.
    if ((group.dest === 'info' || group.dest === 'body') && INFO_FIELDS.has(name)) {
      const field = INFO_FIELDS.get(name)!;
      own('infofield', field === 'created' || field === 'modified' ? { text: '', date: [] } : { text: '' });
      group.infoField = field;
      return true;
    }
    if (SKIPPED_DESTINATIONS.has(name) || group.ignorable) {
      group.dest = 'skip';
      return true;
    }
    return false;
  }

  /** The current group closes: finish what it owns and restore the parent state. */
  function closeGroup(): void {
    const closing = group;
    group = stack.pop()!;
    if (closing.dest === 'style') {
      const name = closing.owns?.text ?? '';
      const level = closing.styleOutline ?? headingStyleLevel(name.endsWith(';') ? name.slice(0, -1) : name);
      const number = closing.styleNumber ?? 0;
      if (!styles.has(number) && styles.size < MAX_FONTS)
        styles.set(number, level === undefined ? {} : { level });
      return;
    }
    const story = closing.owns;
    if (!story) return;
    switch (closing.dest) {
      case 'header':
      case 'footer': {
        unstage(story.text.length);
        const text = story.text.trim();
        if (!text) break;
        if (closing.dest === 'footer') {
          if (!footers.includes(text)) footers.push(text);
        } else if (!headers.has(text)) {
          headers.add(text);
          if (!out.headerFooter('header', text, loc)) halted = true;
        }
        break;
      }
      case 'footnote':
      case 'annotation': {
        const text = story.text.trim();
        unstage(story.text.length - text.length);
        const author = annotationAuthor;
        annotationAuthor = undefined;
        if (!text) break;
        const note: { role: NoteBlock['role']; text: string; author?: string } = {
          role: story.noteRole ?? 'footnote',
          text,
        };
        if (closing.dest === 'annotation' && author) note.author = author;
        pending.push({ kind: 'note', note });
        break;
      }
      case 'atnauthor':
        annotationAuthor = story.text.trim() || undefined;
        break;
      case 'listtext':
        listMarker = story.text;
        break;
      case 'infofield':
        if (closing.infoField) setInfoValue(closing.infoField, story);
        break;
      case 'pict':
        if (story.picture) finishPicture(story.picture);
        break;
      default:
        break;
    }
  }

  function control(name: string, value: number | undefined): void {
    if (group.first) {
      group.first = false;
      if (openDestination(name)) return;
    }
    const dest = group.dest;
    if (dest === 'skip') return;
    if (dest === 'fonttbl') {
      if (name === 'f' && value !== undefined) group.fontNumber = value;
      else if (name === 'fcharset' && value !== undefined && group.fontNumber !== undefined) {
        if (fonts.size < MAX_FONTS || fonts.has(group.fontNumber)) fonts.set(group.fontNumber, value);
        else warn('UNREADABLE_PART');
      }
      return;
    }
    if (dest === 'stylesheet' || dest === 'style') {
      if (name === 's' && value !== undefined) group.styleNumber = value;
      else if (name === 'outlinelevel' && value !== undefined) group.styleOutline = value;
      else if (name === 'cs' || name === 'ds' || name === 'ts' || name === 'tsrowd') {
        group.dest = 'skip';
        return;
      }
      if (dest === 'stylesheet' && stack.at(-1)?.dest === 'stylesheet') {
        // This group is one style definition: its text up to ';' is the style name.
        const story: Story = { text: '' };
        group.dest = 'style';
        group.owns = story;
        group.story = story;
      }
      return;
    }
    if (dest === 'infofield') {
      const index = DATE_PARTS.indexOf(name);
      const date = group.story?.date;
      if (index >= 0 && value !== undefined && date) date[index] = value;
      return;
    }
    if (dest === 'pict') {
      const type = PICTURE_TYPES.get(name);
      const picture = group.story?.picture;
      if (!picture) return;
      if (type && !picture.mimeType) {
        picture.mimeType = type[0];
        picture.extension = type[1];
      } else if (value !== undefined && value > 0 && value <= 31_680_000) {
        if (name === 'picwgoal') picture.goal[0] = value;
        else if (name === 'pichgoal') picture.goal[1] = value;
        else if (name === 'picscalex') picture.scale[0] = value;
        else if (name === 'picscaley') picture.scale[1] = value;
      }
      return;
    }
    if (dest === 'info' || dest === 'object') return;

    switch (name) {
      // Document and character formatting.
      case 'ansi':
        setDocumentCodePage(1252);
        return;
      case 'mac':
        setDocumentCodePage(10000);
        return;
      case 'pc':
        setDocumentCodePage(437);
        return;
      case 'ansicpg':
        if (value !== undefined) setDocumentCodePage(value);
        return;
      case 'f':
        if (value !== undefined) {
          group.font = value;
          selectCodePage(fontCodePage(value));
        }
        return;
      case 'uc':
        if (value !== undefined) group.uc = Math.max(0, Math.min(16, value));
        return;
      case 'u':
        if (value !== undefined && (value < -32_768 || value > 65_535)) warn('UNREADABLE_PART');
        else if (value !== undefined) {
          emitText(String.fromCharCode((value < 0 ? value + 65_536 : value) & 0xffff));
          skipFallback = group.uc;
        }
        return;
      case 'b':
        group.bold = value !== 0;
        return;
      case 'i':
        group.italic = value !== 0;
        return;
      case 'v':
        group.hidden = value !== 0;
        return;
      case 'revised':
        group.inserted = value !== 0;
        return;
      case 'deleted':
        group.deleted = value !== 0;
        return;
      case 'plain':
        group.bold = false;
        group.italic = false;
        group.hidden = false;
        group.inserted = false;
        group.deleted = false;
        delete group.font;
        selectCodePage(documentCodePage);
        return;
      // Paragraph formatting.
      case 'pard':
        delete group.style;
        delete group.outline;
        delete group.listId;
        group.listLevel = 0;
        group.inTable = false;
        group.itap = 0;
        return;
      case 's':
        if (value !== undefined) group.style = value;
        return;
      case 'outlinelevel':
        if (value !== undefined && value >= 0) group.outline = value;
        return;
      case 'ls':
        if (value !== undefined) group.listId = value;
        return;
      case 'ilvl':
        if (value !== undefined) group.listLevel = Math.max(0, value);
        return;
      case 'intbl':
        group.inTable = true;
        group.itap = Math.max(group.itap, 1);
        return;
      case 'itap':
        if (value !== undefined) {
          group.itap = Math.max(0, value);
          group.inTable = group.itap > 0;
        }
        return;
      case 'ftnalt':
        if (group.story?.noteRole) group.story.noteRole = 'endnote';
        return;
      // Breaks.
      case 'par':
      case 'sect':
      case 'page':
        if (dest === 'body') finishParagraph();
        else emitText('\n');
        return;
      // Tables.
      case 'trowd':
        if (dest === 'nesttableprops') nestedDefinitions = [];
        else {
          rowDefinitions = [];
          // Hand-written RTF often omits \intbl; the row definition already says a table follows.
          if (dest === 'body') {
            group.inTable = true;
            group.itap = Math.max(group.itap, 1);
          }
        }
        pendingMerge = {};
        return;
      case 'clmgf':
        pendingMerge.mergeH = 'start';
        return;
      case 'clmrg':
        pendingMerge.mergeH = 'continue';
        return;
      case 'clvmgf':
        pendingMerge.mergeV = 'start';
        return;
      case 'clvmrg':
        pendingMerge.mergeV = 'continue';
        return;
      case 'cellx':
        if (value !== undefined) {
          const definitions = dest === 'nesttableprops' ? nestedDefinitions : rowDefinitions;
          if (definitions.length < budget.limits.cells) definitions.push({ right: value, ...pendingMerge });
        }
        pendingMerge = {};
        return;
      case 'cell':
      case 'row':
        if (dest !== 'body') return;
        group.inTable = true;
        group.itap = Math.max(group.itap, 1);
        if (name === 'cell') finishCell();
        else finishRow();
        return;
      case 'nestcell':
        finishNestedCell();
        return;
      case 'nestrow':
        finishNestedRow();
        return;
      default: {
        const character = CHARACTER_WORDS.get(name);
        if (character === undefined || (name === 'tab' && dest === 'listtext')) return;
        if (skipFallback > 0) {
          skipFallback--;
          return;
        }
        emitText(character);
      }
    }
  }

  function symbol(code: number): void {
    if (code !== 42) group.first = false;
    if (code === 42) {
      group.ignorable = true;
      return;
    }
    if (skipFallback > 0) {
      skipFallback--;
      return;
    }
    switch (code) {
      case 92:
      case 123:
      case 125:
        emitText(String.fromCharCode(code));
        return;
      case 126:
        emitText(' ');
        return;
      case 95:
        emitText('‑');
        return;
      case 10:
      case 13:
        if (group.dest === 'body') finishParagraph();
        else emitText('\n');
        return;
      default:
        return;
    }
  }

  // Groups nest like elements, so they share the XML depth limit; deeper groups are skipped whole.
  let overflow = 0;
  let depth = 0;
  try {
    let index = 0;
    while (index < bytes.length && !halted) {
      budget.tick();
      const byte = bytes[index]!;
      if (byte === 123) {
        index++;
        if (overflow > 0) {
          overflow++;
          continue;
        }
        flushRaw();
        skipFallback = 0;
        depth++;
        if (!budget.enterDepth('xml')) {
          overflow = 1;
          continue;
        }
        stack.push(group);
        group = childGroup(group);
        continue;
      }
      if (byte === 125) {
        index++;
        if (overflow > 0) {
          overflow--;
          if (overflow === 0) {
            depth--;
            budget.exitDepth('xml');
          }
          continue;
        }
        flushRaw();
        skipFallback = 0;
        if (stack.length === 0) {
          warn('UNREADABLE_PART');
          continue;
        }
        closeGroup();
        depth--;
        budget.exitDepth('xml');
        selectCodePage(fontCodePage(group.font));
        continue;
      }
      if (byte === 92) {
        const next = bytes[index + 1];
        if (next === undefined) {
          warn('UNREADABLE_PART');
          break;
        }
        if (next === 39) {
          const high = hexValueRtf(bytes[index + 2] ?? -1);
          const low = hexValueRtf(bytes[index + 3] ?? -1);
          index = Math.min(bytes.length, index + 4);
          if (overflow > 0) continue;
          if (high < 0 || low < 0) {
            warn('UNREADABLE_PART');
            continue;
          }
          if (skipFallback > 0) {
            skipFallback--;
            continue;
          }
          if (group.dest === 'pict') addPictureBytes(Uint8Array.of((high << 4) | low));
          else {
            raw.push((high << 4) | low);
            if (raw.length >= MAX_RAW_CHUNK) flushRaw();
          }
          continue;
        }
        if (!isAlpha(next)) {
          index += 2;
          if (overflow > 0) continue;
          flushRaw();
          symbol(next);
          continue;
        }
        // Control word: letters, an optional signed number, and an optional space delimiter.
        let cursor = index + 1;
        let name = '';
        let tooLong = false;
        while (cursor < bytes.length && isAlpha(bytes[cursor]!)) {
          budget.tick();
          if (name.length < MAX_CONTROL_WORD) name += String.fromCharCode(bytes[cursor]!);
          else tooLong = true;
          cursor++;
        }
        if (tooLong) warn('UNREADABLE_PART');
        name = name.toLowerCase();
        let sign = 1;
        if (bytes[cursor] === 45 && isDigit(bytes[cursor + 1] ?? -1)) {
          sign = -1;
          cursor++;
        }
        let value: number | undefined;
        if (cursor < bytes.length && isDigit(bytes[cursor]!)) {
          value = 0;
          while (cursor < bytes.length && isDigit(bytes[cursor]!)) {
            budget.tick();
            value = Math.min(Number.MAX_SAFE_INTEGER, value * 10 + bytes[cursor]! - 48);
            cursor++;
          }
          value *= sign;
        }
        if (bytes[cursor] === 32) cursor++;
        index = cursor;
        if (name === 'bin') {
          // Binary data is skipped by its declared length, never past the end of the input.
          if (value === undefined || value < 0) {
            warn('UNREADABLE_PART');
            continue;
          }
          const amount = Math.min(value, bytes.length - index);
          if (amount < value) warn('UNREADABLE_PART');
          for (let skipped = 0; skipped < amount; skipped += PICTURE_CHUNK) budget.tick();
          if (overflow === 0 && group.dest === 'pict') {
            const picture = group.story?.picture;
            // A picture whose binary data runs past the end of the file is incomplete: never listed.
            if (amount < value && picture) picture.limited = true;
            else addPictureBytes(bytes.subarray(index, index + amount));
          }
          index += amount;
          continue;
        }
        if (overflow > 0 || tooLong) continue;
        flushRaw();
        control(name, value);
        continue;
      }
      index++;
      if (overflow > 0 || byte === 10 || byte === 13) continue;
      if (skipFallback > 0) {
        skipFallback--;
        continue;
      }
      if (group.dest === 'pict') {
        const digit = hexValueRtf(byte);
        if (digit >= 0) addPictureDigit(digit);
        continue;
      }
      if (byte !== 32) group.first = false;
      raw.push(byte);
      if (raw.length >= MAX_RAW_CHUNK) flushRaw();
    }
    flushRaw();
    if (overflow > 0 || stack.length > 0) warn('UNREADABLE_PART');
    // Close what is still open, so an unterminated document keeps the text read so far.
    while (stack.length > 0 && !halted) {
      budget.tick();
      closeGroup();
      depth--;
      budget.exitDepth('xml');
    }
    if (!halted) {
      if (paragraph.trim()) finishParagraph();
      finishTable();
      finishList();
      emitItems(pending.splice(0));
      for (const footer of footers) {
        budget.tick();
        if (halted || !out.headerFooter('footer', footer, loc)) break;
      }
    }
    if (
      metadata.title !== undefined ||
      metadata.authors !== undefined ||
      metadata.created !== undefined ||
      metadata.modified !== undefined ||
      metadata.custom !== undefined
    )
      out.setMetadata(metadata);
    if (revisionsSeen)
      warnings.add({
        code: 'HIDDEN_CONTENT',
        message: `The document has tracked changes; they were applied in "${options.revisions}" mode.`,
      });
    if (hiddenSeen)
      warnings.add({
        code: 'HIDDEN_CONTENT',
        message: 'Hidden text was left out; set includeHidden to keep it.',
      });
  } finally {
    while (depth > 0) {
      depth--;
      budget.exitDepth('xml');
    }
  }
}
