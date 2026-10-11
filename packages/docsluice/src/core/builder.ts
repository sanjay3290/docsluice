import type {
  Block,
  Cell,
  ChildDocument,
  DocsluiceDocument,
  Features,
  FormatId,
  ListItem,
  Location,
  Metadata,
  NoteBlock,
  Run,
  SectionBlock,
  Warning,
} from './model.js';
import type { ExtractOptions, ResolvedOptions } from './options.js';
import type { Budget } from './budget.js';

type SectionRole = SectionBlock['role'];
type NoteRole = NoteBlock['role'];
type FeatureName = keyof Features;

interface SectionFrame {
  section?: SectionBlock;
  /** Target for blocks emitted while this logical section is open. */
  target: Block[];
  parentTarget: Block[];
  entered: boolean;
  pendingStart?: number;
}

interface BlockArrayFrame {
  blocks: Block[];
  depth: number;
  index: number;
  entered: boolean;
}

interface ItemArrayFrame {
  items: ListItem[];
  depth: number;
  index: number;
  entered: boolean;
}

const emptyFeatures = (): Features => ({
  hasMacros: false,
  hasExternalLinks: false,
  hasEmbeddedFiles: false,
  isEncrypted: false,
  hasJavaScript: false,
});

/** Copy byte arrays without widening their numeric index type through a generic. */
function cloneBytes(bytes: Uint8Array, budget: Budget): Uint8Array {
  const copy: Uint8Array = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index++) {
    budget.tick();
    copy[index] = bytes[index]!;
  }
  return copy;
}

/**
 * Copy JSON-like model data without recursion or caller-owned references.
 * Cycles are rejected because a cyclic block tree cannot be rendered safely.
 */
function cloneValue<T>(input: T, budget: Budget): T {
  if (input === null || typeof input !== 'object') return input;
  if (input instanceof Uint8Array) {
    return cloneBytes(input, budget) as T;
  }
  const root = Array.isArray(input) ? [] : {};
  const active = new Set<object>();
  // Arrays are walked by index (`keys` undefined); objects by their enumerable own string keys.
  const stack: Array<{
    source: Record<string, unknown>;
    target: Record<string, unknown>;
    keys: string[] | undefined;
    index: number;
  }> = [];
  const begin = (source: object, target: object): void => {
    active.add(source);
    stack.push({
      source: source as Record<string, unknown>,
      target: target as Record<string, unknown>,
      keys: Array.isArray(source) ? undefined : Object.keys(source),
      index: 0,
    });
  };
  begin(input, root);
  while (stack.length > 0) {
    budget.tick();
    const frame = stack[stack.length - 1]!;
    const elements = frame.keys ? undefined : (frame.source as unknown as unknown[]);
    if (frame.index >= (elements ? elements.length : frame.keys!.length)) {
      active.delete(frame.source);
      stack.pop();
      continue;
    }
    const position = frame.index++;
    if (elements && !Object.hasOwn(elements, position)) continue;
    const keys = frame.keys;
    const key = keys ? keys[position] : undefined;
    const value: unknown = key === undefined ? elements![position] : Reflect.get(frame.source, key);
    let copied = value;
    if (value !== null && typeof value === 'object') {
      if (active.has(value)) throw new TypeError('Block data must not contain cycles.');
      copied = value instanceof Uint8Array ? cloneBytes(value, budget) : Array.isArray(value) ? [] : {};
    }
    if (key === undefined) {
      // Index assignment keeps arrays dense; it cannot reach `__proto__` or other named setters.
      (frame.target as unknown as unknown[])[position] = copied;
    } else if (key === '__proto__') {
      // A plain set would invoke the prototype setter; define it as an own data property (SEC-6).
      Object.defineProperty(frame.target, key, {
        value: copied,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    } else {
      Reflect.set(frame.target, key, copied);
    }
    if (copied !== value && !(copied instanceof Uint8Array)) begin(value as object, copied as object);
  }
  return root as T;
}

/** Drop raw bytes recursively from child documents when the option is disabled. */
function stripChildBytes(children: ChildDocument[], budget: Budget): void {
  const pending = [...children];
  while (pending.length > 0) {
    budget.tick();
    const child = pending.pop()!;
    delete child.bytes;
    if (child.document) {
      for (const nested of child.document.children) {
        budget.tick();
        pending.push(nested);
      }
    }
  }
}

/**
 * Whether `normalizeText` would return `text` unchanged: no CR or other control characters, no
 * white space before a line end (or at the end unless `keepTrailing`), no run of more than two
 * line breaks, and nothing at or above U+0300 that NFC could change. One linear scan, so most
 * extracted text skips the copying passes (#182).
 */
function isNormalized(text: string, keepTrailing: boolean, budget: Budget): boolean {
  let spaceRun = false;
  let breaks = 0;
  for (let index = 0; index < text.length; index++) {
    if ((index & 0xfff) === 0) budget.tick();
    const code = text.charCodeAt(index);
    if (code === 0x0a) {
      if (spaceRun || ++breaks > 2) return false;
      continue;
    }
    breaks = 0;
    if (code === 0x20 || code === 0x09) spaceRun = true;
    else if (code < 0x20 || code >= 0x300) return false;
    else spaceRun = false;
  }
  return keepTrailing || !spaceRun;
}

/**
 * `keepTrailing` keeps horizontal white space at the very end, for a run that more text follows:
 * a run's trailing space is not a line end (MOD-3).
 */
function normalizeText(text: string, budget: Budget, keepTrailing = false): string {
  if (isNormalized(text, keepTrailing, budget)) return text;
  let lines = '';
  for (let index = 0; index < text.length; index++) {
    budget.tick();
    const code = text.charCodeAt(index);
    if (code === 0x0d) {
      if (text.charCodeAt(index + 1) === 0x0a) index++;
      lines += '\n';
    } else if (code === 0x09 || code === 0x0a || code >= 0x20) {
      lines += text[index];
    }
  }
  budget.tick();
  const normalized = lines.normalize('NFC');
  budget.tick();
  if (normalized.length === 0) return '';
  let output = '';
  for (let index = 0; index < normalized.length;) {
    budget.tick();
    const code = normalized.charCodeAt(index);
    if (code === 0x20 || code === 0x09) {
      const start = index;
      while (
        index < normalized.length &&
        (normalized.charCodeAt(index) === 0x20 || normalized.charCodeAt(index) === 0x09)
      ) {
        budget.tick();
        index++;
      }
      if (index < normalized.length ? normalized.charCodeAt(index) !== 0x0a : keepTrailing)
        output += normalized.slice(start, index);
      continue;
    }
    if (code === 0x0a) {
      let breaks = 0;
      while (index < normalized.length && normalized.charCodeAt(index) === 0x0a) {
        budget.tick();
        breaks++;
        index++;
      }
      output += breaks > 1 ? '\n\n' : '\n';
      continue;
    }
    output += normalized[index];
    index++;
  }
  return output;
}

function stripPersonalDocument(document: DocsluiceDocument, budget: Budget): void {
  const documents = [document];
  while (documents.length > 0) {
    budget.tick();
    const current = documents.pop()!;
    delete current.metadata.authors;
    delete current.metadata.custom;
    const blocks: Block[] = [];
    for (const block of current.blocks) {
      budget.tick();
      blocks.push(block);
    }
    while (blocks.length > 0) {
      budget.tick();
      const block = blocks.pop()!;
      if (block.kind === 'note') delete block.author;
      if (block.kind === 'section') {
        for (const child of block.blocks) {
          budget.tick();
          blocks.push(child);
        }
      }
    }
    for (const child of current.children) {
      budget.tick();
      if (child.document) documents.push(child.document);
    }
  }
}

/**
 * Normalize a paragraph's runs so they join to exactly its normalized `text`: each run keeps its
 * trailing white space except the last, and empty runs go. When a line end or a combining mark
 * falls between two runs, normalizing them apart can still differ from the whole; then the runs
 * become one plain run, so the text is never wrong.
 */
function normalizeRuns(paragraph: Extract<Block, { kind: 'paragraph' }>, budget: Budget): void {
  const runs = paragraph.runs!;
  const kept: Run[] = [];
  let joined = '';
  for (let index = 0; index < runs.length; index++) {
    budget.tick();
    const run = runs[index]!;
    run.text = normalizeText(run.text, budget, index < runs.length - 1);
    if (run.text.length === 0) continue;
    joined += run.text;
    kept.push(run);
  }
  if (joined !== paragraph.text) {
    paragraph.runs = paragraph.text.length > 0 ? [{ text: paragraph.text }] : [];
    return;
  }
  paragraph.runs = kept;
}

function normalizeBlockStrings(block: Block, stripAuthors: boolean, budget: Budget): void {
  const stack: Block[] = [block];
  while (stack.length > 0) {
    budget.tick();
    const current = stack.pop()!;
    switch (current.kind) {
      case 'heading':
      case 'paragraph':
      case 'code':
      case 'note':
      case 'header':
      case 'footer':
        if (current.kind === 'note' && stripAuthors) delete current.author;
        current.text = normalizeText(current.text, budget);
        if (current.kind === 'paragraph' && current.runs) normalizeRuns(current, budget);
        break;
      case 'list': {
        const items: ListItem[] = [];
        for (const item of current.items) {
          budget.tick();
          items.push(item);
        }
        while (items.length > 0) {
          budget.tick();
          const item = items.pop()!;
          item.text = normalizeText(item.text, budget);
          if (item.marker !== undefined) item.marker = normalizeText(item.marker, budget);
          if (item.items) {
            for (const child of item.items) {
              budget.tick();
              items.push(child);
            }
          }
        }
        break;
      }
      case 'table':
        for (const row of current.rows) {
          budget.tick();
          for (const cell of row) {
            budget.tick();
            cell.text = normalizeText(cell.text, budget);
          }
        }
        if (current.caption !== undefined) current.caption = normalizeText(current.caption, budget);
        break;
      case 'image':
        if (current.alt !== undefined) current.alt = normalizeText(current.alt, budget);
        break;
      case 'section':
        if (current.title !== undefined) current.title = normalizeText(current.title, budget);
        for (const child of current.blocks) {
          budget.tick();
          stack.push(child);
        }
        break;
    }
  }
}

function ownTextLength(block: Block, budget: Budget): number {
  switch (block.kind) {
    case 'heading':
    case 'code':
    case 'note':
    case 'header':
    case 'footer':
      return block.text.length;
    case 'paragraph':
      // Runs encode the same visible paragraph text with optional formatting.
      return block.text.length;
    case 'list': {
      let total = 0;
      const items: ListItem[] = [];
      for (const item of block.items) {
        budget.tick();
        items.push(item);
      }
      while (items.length > 0) {
        budget.tick();
        const item = items.pop()!;
        total += item.text.length + (item.marker?.length ?? 0);
        if (item.items) {
          for (const child of item.items) {
            budget.tick();
            items.push(child);
          }
        }
      }
      return total;
    }
    case 'table': {
      let total = block.caption?.length ?? 0;
      for (const row of block.rows) {
        budget.tick();
        for (const cell of row) {
          budget.tick();
          total += cell.text.length;
        }
      }
      return total;
    }
    case 'image':
      return block.alt?.length ?? 0;
    case 'section':
      return block.title?.length ?? 0;
  }
}

function treeTextLength(root: Block, budget: Budget): number {
  let total = 0;
  const stack: Block[] = [root];
  while (stack.length > 0) {
    budget.tick();
    const block = stack.pop()!;
    total += ownTextLength(block, budget);
    if (block.kind === 'section') {
      for (const child of block.blocks) {
        budget.tick();
        stack.push(child);
      }
    }
  }
  return total;
}

/** Builds the one public document model from reader output under the shared limits. */
export class DocBuilder {
  readonly #format: FormatId;
  readonly #mimeType: string;
  readonly #budget: Budget;
  readonly #options: ExtractOptions | ResolvedOptions;
  readonly #drain: (() => Promise<void> | undefined) | undefined;
  readonly #blocks: Block[] = [];
  readonly #sections: SectionFrame[] = [];
  readonly #metadata: Metadata = {};
  readonly #features = emptyFeatures();
  readonly #children: ChildDocument[] = [];
  #encoding: string | undefined;
  #needsOcr = false;
  #depthWarned = false;
  #stopped = false;
  #finished = false;
  #sectionDepth = 0;
  #pendingOutputChars = 0;

  /**
   * @param format Detected or forced document format.
   * @param mimeType MIME type selected by the detector or reader.
   * @param budget Shared extraction budget and warning collector.
   * @param options Effective extraction options, including transform and onBlock hooks.
   * @param drain Internal backpressure hook from `extractStream()`: a promise while the consumer
   *   has too many blocks waiting, otherwise `undefined`.
   */
  constructor(
    format: FormatId,
    mimeType: string,
    budget: Budget,
    options: ExtractOptions | ResolvedOptions = {},
    drain?: () => Promise<void> | undefined,
  ) {
    this.#format = format;
    this.#mimeType = mimeType;
    this.#budget = budget;
    this.#options = options;
    this.#drain = drain;
  }

  /**
   * A yield point for readers between batches of output (EXT-2). Under `extractStream()` it waits
   * while the consumer has too many blocks waiting, so a slow consumer bounds buffered output; it
   * also checks cancellation. Outside streaming it resolves at once.
   */
  async flush(): Promise<void> {
    this.#budget.tick();
    const waiting = this.#drain?.();
    if (waiting) await waiting;
    this.#budget.tick();
  }

  /** Add a heading. Returns false when output was truncated. */
  heading(level: 1 | 2 | 3 | 4 | 5 | 6, text: string, loc: Location = {}): boolean {
    return this.#emit({ kind: 'heading', level, text, loc });
  }

  /** Add a paragraph, optionally retaining inline formatting runs. */
  paragraph(
    text: string,
    loc: Location = {},
    runs?: NonNullable<Extract<Block, { kind: 'paragraph' }>['runs']>,
  ): boolean {
    const paragraph: Extract<Block, { kind: 'paragraph' }> = { kind: 'paragraph', text, loc };
    if (this.#options.runs && runs !== undefined) paragraph.runs = runs;
    return this.#emit(paragraph);
  }

  /** Add a list. Nested items deeper than `blockDepth` are flattened. */
  list(ordered: boolean, items: ListItem[], loc: Location = {}): boolean {
    return this.#emit({ kind: 'list', ordered, items, loc });
  }

  /** Add a table; the header consists of the first `headerRows` rows. */
  table(rows: Cell[][], headerRows: number, loc: Location = {}, caption?: string): boolean {
    const table: Extract<Block, { kind: 'table' }> = { kind: 'table', rows, headerRows, loc };
    if (caption !== undefined) table.caption = caption;
    return this.#emit(table);
  }

  /** Add a code block. */
  code(text: string, loc: Location = {}, lang?: string): boolean {
    const block: Extract<Block, { kind: 'code' }> = { kind: 'code', text, loc };
    if (lang !== undefined) block.language = lang;
    return this.#emit(block);
  }

  /** Add an image with any known descriptive fields. */
  image(image: Omit<Extract<Block, { kind: 'image' }>, 'kind' | 'loc'>, loc: Location = {}): boolean {
    return this.#emit({ kind: 'image', ...cloneValue(image, this.#budget), loc });
  }

  /** Add a note, omitting its author when personal metadata is disabled. */
  note(role: NoteRole, text: string, loc: Location = {}, author?: string): boolean {
    const note: NoteBlock = { kind: 'note', role, text, loc };
    if (author !== undefined && this.#options.metadata !== false) note.author = author;
    return this.#emit(note);
  }

  /** Add a document header or footer. */
  headerFooter(kind: 'header' | 'footer', text: string, loc: Location = {}): boolean {
    return this.#emit({ kind, text, loc });
  }

  /**
   * Open a section; sections exceeding `blockDepth` are flattened into their parent.
   * `hidden` marks hidden sheets and slides (XLS-1, PPT-5); `needsOcr` marks PDF pages with no
   * text layer (PDF-4).
   */
  openSection(
    role: SectionRole,
    loc: Location = {},
    title?: string,
    hidden?: boolean | 'very',
    needsOcr?: boolean,
  ): boolean {
    if (this.#stopped) return false;
    const parentTarget = this.#target();
    const canNest = this.#sectionDepth + 1 <= this.#budget.limits.blockDepth;
    if (canNest && this.#budget.enterDepth('block')) {
      try {
        const section: SectionBlock = { kind: 'section', role, blocks: [], loc };
        if (title !== undefined) section.title = normalizeText(title, this.#budget);
        if (hidden !== undefined && hidden !== false) section.hidden = hidden;
        if (needsOcr === true) section.needsOcr = true;
        const pendingStart = this.#pendingOutputChars;
        const pending = pendingStart + (section.title?.length ?? 0);
        const canKeep = this.#budget.checkOutputChars(pending);
        this.#sectionDepth++;
        if (!canKeep) {
          this.#stopped = true;
          this.#sections.push({ target: parentTarget, parentTarget, entered: true, pendingStart });
          return false;
        }
        this.#pendingOutputChars = pending;
        this.#sections.push({ section, target: section.blocks, parentTarget, entered: true, pendingStart });
      } catch (error) {
        this.#budget.exitDepth('block');
        throw error;
      }
    } else {
      this.#warnDepth();
      this.#sections.push({ target: parentTarget, parentTarget, entered: false });
    }
    return true;
  }

  /** Close the most recently opened section and emit it into its parent. */
  closeSection(): boolean {
    const wasStopped = this.#stopped;
    const frame = this.#sections.pop();
    if (!frame) throw new RangeError('No section is open.');
    if (frame.entered) {
      this.#budget.exitDepth('block');
      this.#sectionDepth--;
    }
    if (!frame.section) return wasStopped ? false : true;
    const emitted = this.#emit(frame.section, frame.parentTarget, frame.pendingStart);
    return wasStopped ? false : emitted;
  }

  /** Merge reader metadata. With metadata disabled, personal fields are removed at finish. */
  setMetadata(partial: Partial<Metadata>): void {
    const copied = cloneValue(partial, this.#budget);
    if (copied.title !== undefined) this.#metadata.title = copied.title;
    if (copied.authors !== undefined) this.#metadata.authors = copied.authors;
    if (copied.created !== undefined) this.#metadata.created = copied.created;
    if (copied.modified !== undefined) this.#metadata.modified = copied.modified;
    if (copied.pageCount !== undefined) this.#metadata.pageCount = copied.pageCount;
    if (copied.language !== undefined) this.#metadata.language = copied.language;
    if (copied.custom !== undefined) this.#metadata.custom = copied.custom;
  }

  /** Record that a feature exists; docsluice never executes document features. */
  setFeature(name: FeatureName): void {
    switch (name) {
      case 'hasMacros':
        this.#features.hasMacros = true;
        break;
      case 'hasExternalLinks':
        this.#features.hasExternalLinks = true;
        break;
      case 'hasEmbeddedFiles':
        this.#features.hasEmbeddedFiles = true;
        break;
      case 'isEncrypted':
        this.#features.isEncrypted = true;
        break;
      case 'hasJavaScript':
        this.#features.hasJavaScript = true;
        break;
    }
  }

  /** Record text encoding selected by a text reader. */
  setEncoding(encoding: string): void {
    this.#encoding = encoding;
  }

  /** Mark a page or document that has no usable text layer. */
  setNeedsOcr(needsOcr = true): void {
    this.#needsOcr = needsOcr;
  }

  /** Add an extracted or listed child document. */
  addChild(child: ChildDocument): void {
    const copied = cloneValue(child, this.#budget);
    if (this.#options.childBytes !== true) stripChildBytes([copied], this.#budget);
    if (this.#options.metadata === false && copied.document)
      stripPersonalDocument(copied.document, this.#budget);
    this.#children.push(copied);
  }

  /** Finish the document with an immutable snapshot of collected output and warnings. */
  finish(): DocsluiceDocument {
    if (this.#sections.length > 0 && !this.#stopped) {
      throw new RangeError('All sections must be closed before finishing.');
    }
    while (this.#sections.length > 0) this.closeSection();
    const metadata = cloneValue(this.#metadata, this.#budget);
    if (this.#options.metadata === false) {
      delete metadata.authors;
      delete metadata.custom;
    }
    const document: DocsluiceDocument = {
      format: this.#format,
      mimeType: this.#mimeType,
      metadata,
      features: cloneValue(this.#features, this.#budget),
      // Emitted blocks are already private copies, so the first finish hands them over instead of
      // copying the whole tree again (#182); a later finish returns a copy.
      blocks: this.#finished ? cloneValue(this.#blocks, this.#budget) : this.#blocks,
      children: cloneValue(this.#children, this.#budget),
      warnings: cloneValue(this.#budget.warnings.warnings as Warning[], this.#budget),
      stats: {
        bytesRead: this.#budget.inputBytes,
        durationMs: 0,
        truncated: this.#budget.truncated,
        needsOcr: this.#needsOcr,
      },
    };
    if (this.#encoding !== undefined) document.encoding = this.#encoding;
    this.#finished = true;
    return document;
  }

  #target(): Block[] {
    return this.#sections[this.#sections.length - 1]?.target ?? this.#blocks;
  }

  #emit(block: Block, target = this.#target(), pendingStart?: number): boolean {
    if (this.#stopped && pendingStart === undefined) return false;
    let candidate = cloneValue(block, this.#budget);
    normalizeBlockStrings(candidate, this.#options.metadata === false, this.#budget);
    if (this.#options.transform) {
      const transformed = this.#options.transform(candidate);
      if (transformed === null) {
        if (pendingStart !== undefined) this.#pendingOutputChars = pendingStart;
        return true;
      }
      if (transformed === undefined) throw new TypeError('transform must return a block or null.');
      // The transform may keep or mutate what it returns, so retain a fresh normalized copy.
      candidate = cloneValue(transformed, this.#budget);
      normalizeBlockStrings(candidate, this.#options.metadata === false, this.#budget);
    }
    const forest = this.#flattenToDepth(candidate);
    let textLength = 0;
    for (const retained of forest) {
      this.#budget.tick();
      textLength += treeTextLength(retained, this.#budget);
    }
    if (pendingStart !== undefined) {
      const staged = pendingStart + textLength;
      if (!this.#budget.checkOutputChars(staged)) {
        this.#pendingOutputChars = pendingStart;
        this.#stopped = true;
        return false;
      }
      if (target === this.#blocks) {
        if (!this.#budget.addOutputChars(textLength)) {
          this.#pendingOutputChars = pendingStart;
          this.#stopped = true;
          return false;
        }
        this.#pendingOutputChars = pendingStart;
      } else {
        this.#pendingOutputChars = staged;
      }
    } else if (target !== this.#blocks) {
      const staged = this.#pendingOutputChars + textLength;
      if (!this.#budget.checkOutputChars(staged)) {
        this.#stopped = true;
        return false;
      }
      this.#pendingOutputChars = staged;
    } else if (!this.#budget.addOutputChars(textLength)) {
      this.#stopped = true;
      return false;
    }
    if (target === this.#blocks) {
      for (const retained of forest) {
        this.#budget.tick();
        this.#options.onBlock?.(cloneValue(retained, this.#budget));
      }
    }
    for (const retained of forest) {
      this.#budget.tick();
      target.push(retained);
    }
    return true;
  }

  #flattenToDepth(root: Block): Block[] {
    const maxDepth = this.#budget.limits.blockDepth;
    const baseDepth = this.#sectionDepth;
    const forest: Block[] = [root];
    const stack: BlockArrayFrame[] = [{ blocks: forest, depth: baseDepth, index: 0, entered: false }];
    try {
      while (stack.length > 0) {
        this.#budget.tick();
        const frame = stack[stack.length - 1]!;
        if (frame.index >= frame.blocks.length) {
          stack.pop();
          if (frame.entered) {
            frame.entered = false;
            this.#budget.exitDepth('block');
          }
          continue;
        }
        const block = frame.blocks[frame.index]!;
        if (block.kind !== 'section') {
          if (block.kind === 'list') this.#flattenList(block, frame.depth);
          frame.index++;
          continue;
        }
        if (frame.depth + 1 > maxDepth) {
          this.#replaceBlocks(frame.blocks, frame.index, block.blocks);
          this.#warnDepth();
          continue;
        }
        if (!this.#budget.enterDepth('block')) {
          this.#replaceBlocks(frame.blocks, frame.index, block.blocks);
          this.#warnDepth();
          continue;
        }
        frame.index++;
        stack.push({ blocks: block.blocks, depth: frame.depth + 1, index: 0, entered: true });
      }
      return forest;
    } finally {
      for (const frame of stack) {
        if (frame.entered) {
          frame.entered = false;
          this.#budget.exitDepth('block');
        }
      }
    }
  }

  #flattenList(block: Extract<Block, { kind: 'list' }>, baseDepth: number): void {
    const maxDepth = this.#budget.limits.blockDepth;
    const stack: ItemArrayFrame[] = [];
    const rootDepth = baseDepth + 1;
    let rootEntered = false;
    if (rootDepth <= maxDepth) rootEntered = this.#budget.enterDepth('block');
    else this.#warnDepth();
    if (rootEntered) stack.push({ items: block.items, depth: rootDepth, index: 0, entered: true });
    else stack.push({ items: block.items, depth: Math.min(rootDepth, maxDepth), index: 0, entered: false });

    try {
      while (stack.length > 0) {
        this.#budget.tick();
        const frame = stack[stack.length - 1]!;
        if (frame.index >= frame.items.length) {
          stack.pop();
          if (frame.entered) {
            frame.entered = false;
            this.#budget.exitDepth('block');
          }
          continue;
        }
        const item = frame.items[frame.index]!;
        if (!item.items || item.items.length === 0) {
          delete item.items;
          frame.index++;
          continue;
        }
        const childDepth = frame.depth + 1;
        if (childDepth > maxDepth) {
          this.#insertItems(frame.items, frame.index + 1, item.items);
          delete item.items;
          this.#warnDepth();
          frame.index++;
          continue;
        }
        const entered = this.#budget.enterDepth('block');
        if (!entered) {
          this.#insertItems(frame.items, frame.index + 1, item.items);
          delete item.items;
          this.#warnDepth();
          frame.index++;
          continue;
        }
        frame.index++;
        stack.push({ items: item.items, depth: childDepth, index: 0, entered: true });
      }
    } finally {
      for (const frame of stack) {
        if (frame.entered) {
          frame.entered = false;
          this.#budget.exitDepth('block');
        }
      }
    }
  }

  #warnDepth(): void {
    if (this.#depthWarned) return;
    this.#depthWarned = true;
    this.#budget.warnings.add({
      code: 'DEPTH_LIMIT',
      message: `Block nesting was flattened at the configured limit of ${this.#budget.limits.blockDepth}.`,
    });
  }

  #replaceBlocks(target: Block[], index: number, blocks: Block[]): void {
    const oldLength = target.length;
    const delta = blocks.length - 1;
    if (delta > 0) target.length = oldLength + delta;
    for (let source = oldLength - 1; source > index; source--) {
      this.#budget.tick();
      target[source + delta] = target[source]!;
    }
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      this.#budget.tick();
      target[index + blockIndex] = blocks[blockIndex]!;
    }
    if (delta < 0) target.length = oldLength + delta;
  }

  #insertItems(target: ListItem[], index: number, items: ListItem[]): void {
    const oldLength = target.length;
    target.length = oldLength + items.length;
    for (let source = oldLength - 1; source >= index; source--) {
      this.#budget.tick();
      target[source + items.length] = target[source]!;
    }
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      this.#budget.tick();
      target[index + itemIndex] = items[itemIndex]!;
    }
  }
}
