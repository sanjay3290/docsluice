import type { Budget } from '../../core/budget.js';

/**
 * The only module that knows the PDF engine's API (ADR 0009). The rest of the PDF reader uses
 * these small types, so the engine can be replaced without touching reading logic.
 */

/** A run of text at a position, in PDF user space (origin bottom-left). */
export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The engine saw a line end after this item. */
  endOfLine: boolean;
  /** Text direction: the first column of the item's text matrix. */
  dirX: number;
  dirY: number;
  /** The engine marked the item right-to-left. */
  rtl: boolean;
}

export interface PdfLink {
  /** Absolute http(s) or mailto URL; other targets are only counted. */
  url?: string;
  /** A remote file, launch action or non-web URL: reported, never followed (PDF-10). */
  remote: boolean;
  /** Link rectangle [x1, y1, x2, y2] in user space. */
  rect: [number, number, number, number];
}

export interface PdfPageContent {
  width: number;
  height: number;
  items: PdfTextItem[];
  links: PdfLink[];
  /** Form fields whose widgets are on this page, by full name (PDF-7). */
  fields: PdfField[];
  /** Text and free-text annotations (PDF-7). */
  notes: PdfNote[];
  hasJavaScript: boolean;
}

export interface PdfField {
  /** Fully qualified name, `parent.child`. */
  name: string;
  /** Text value; the export value of a check box or radio group (`Off` when off); choices joined. */
  value: string;
}

export interface PdfNote {
  text: string;
  /** The annotation's `/T` (personal data: the builder drops it with `metadata: false`). */
  author?: string;
}

export interface PdfOutlineItem {
  title: string;
  /** 0-based page index, when the destination resolves. */
  pageIndex?: number;
  depth: number;
}

export interface PdfInfo {
  title?: string;
  author?: string;
  subject?: string;
  creationDate?: string;
  modDate?: string;
  language?: string;
  xmpTitle?: string;
  xmpCreator?: string;
  /** The file has an `/Encrypt` dictionary, even if it opened without a password. */
  encrypted: boolean;
  /** The document has an XFA form (never parsed). */
  xfa: boolean;
}

export interface PdfDocument {
  pageCount: number;
  pageLabels(): Promise<string[] | undefined>;
  info(): Promise<PdfInfo>;
  outline(budget: Budget): Promise<PdfOutlineItem[]>;
  hasJavaScript(): Promise<boolean>;
  hasAttachments(): Promise<boolean>;
  page(index: number, budget: Budget): Promise<PdfPageContent>;
  /** Fraction of the page area painted by images (for needsOcr); 0 when there are none. */
  imageCoverage(index: number, budget: Budget): Promise<number>;
  /** Fonts the engine has loaded for this document so far. */
  readonly fontsLoaded: number;
  /** The engine refused a font because the font allowance was used up. */
  readonly fontsDenied: boolean;
  close(): Promise<void>;
}

/** Thrown by `openPdf` when the document needs a password. */
export class PdfPasswordError extends Error {
  readonly wrongPassword: boolean;

  constructor(wrongPassword: boolean) {
    super(wrongPassword ? 'wrong password' : 'password required');
    this.wrongPassword = wrongPassword;
  }
}

/** Thrown by `openPdf` when the file uses a security handler or algorithm the engine lacks. */
export class PdfUnsupportedEncryptionError extends Error {
  constructor() {
    super('unsupported encryption');
  }
}

/** The engine's fixed messages for encryption it cannot open (no document content). */
const UNSUPPORTED_ENCRYPTION = new Set([
  'unknown encryption method',
  'unsupported encryption algorithm',
  'Unknown crypto method',
]);

// Minimal shapes of the pdf.js objects used here.
interface EngineTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
  dir?: string;
}
interface EngineAnnotation {
  subtype?: string;
  url?: string;
  unsafeUrl?: string;
  rect?: number[];
  actions?: Record<string, unknown>;
  fieldName?: unknown;
  fieldType?: unknown;
  fieldValue?: unknown;
  pushButton?: boolean;
  contentsObj?: { str?: unknown };
  titleObj?: { str?: unknown };
}
interface EngineOutlineNode {
  title?: string;
  dest?: unknown;
  items?: EngineOutlineNode[];
}
interface EnginePage {
  view: number[];
  getTextContent(): Promise<{ items: unknown[] }>;
  getAnnotations(): Promise<EngineAnnotation[]>;
  getJSActions(): Promise<Record<string, unknown> | null>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  cleanup(): void;
}
interface EngineDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<EnginePage>;
  getPageLabels(): Promise<string[] | null>;
  getMetadata(): Promise<{
    info?: Record<string, unknown>;
    metadata?: { get(name: string): unknown } | null;
  }>;
  getOutline(): Promise<EngineOutlineNode[] | null>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
  getJSActions(): Promise<Record<string, unknown> | null>;
  getAttachments(): Promise<Record<string, unknown> | null>;
}
interface EngineFontTracker {
  readonly loaded: number;
  readonly denied: boolean;
  release(): void;
}
interface EngineModule {
  getDocument(options: Record<string, unknown>): {
    docId: string;
    promise: Promise<EngineDocument>;
    destroy(): Promise<void>;
  };
  OPS: Record<string, number>;
  /** Added by the docsluice build patch (scripts/pdfjs-patch.mjs, #262). */
  docsluiceTrackPdfFonts?(loadingTaskDocId: string, limit: number): EngineFontTracker;
}

/** Options from ADR 0009: no eval, no network, no font or CMap loading, no worker. */
const ENGINE_OPTIONS = {
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  disableAutoFetch: true,
  disableStream: true,
  disableRange: true,
  useWorkerFetch: false,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  enableXfa: false,
  stopAtErrors: false,
  maxImageSize: 16_777_216,
  verbosity: 0,
};

/** The serverless pdf.js build, loaded only when a PDF arrives. */
async function loadEngine(): Promise<EngineModule> {
  return (await import('unpdf/pdfjs')) as unknown as EngineModule;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function isWebUrl(url: string): boolean {
  const lower = url.slice(0, 8).toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:');
}

/** A field value as text: strings as they are, choices joined with `, `, nothing as empty. */
function fieldValue(value: unknown, budget: Budget): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const part of value as unknown[]) {
    budget.tick();
    if (typeof part === 'string') parts.push(part);
  }
  return parts.join(', ');
}

function hasEntries(value: Record<string, unknown> | null | undefined): boolean {
  return value !== null && value !== undefined && Object.keys(value).length > 0;
}

/**
 * Open a PDF with the engine. Password-protected files throw `PdfPasswordError`. The engine loads
 * at most `fontLimit` fonts for this document; it gives any further font an error font.
 */
export async function openPdf(
  bytes: Uint8Array,
  password: string | undefined,
  fontLimit: number,
): Promise<PdfDocument> {
  const engine = await loadEngine();
  // Fail closed: without the build patch, nothing bounds the fonts the engine loads.
  if (typeof engine.docsluiceTrackPdfFonts !== 'function') throw new Error('unpatched PDF engine');
  // pdf.js may transfer the buffer; give it a copy so the caller's bytes stay intact. A plain
  // Uint8Array copy: a subclass's slice() may return a view, and pdf.js refuses Node's Buffer.
  const task = engine.getDocument({
    data: new Uint8Array(bytes),
    ...ENGINE_OPTIONS,
    ...(password !== undefined ? { password } : {}),
  });
  const fonts = engine.docsluiceTrackPdfFonts(task.docId, fontLimit);
  let document: EngineDocument;
  try {
    document = await task.promise;
  } catch (error) {
    fonts.release();
    await task.destroy().catch(() => undefined);
    const name = (error as { name?: unknown }).name;
    if (name === 'PasswordException') {
      const code = (error as { code?: unknown }).code;
      throw new PdfPasswordError(code === 2);
    }
    if (UNSUPPORTED_ENCRYPTION.has(String((error as { message?: unknown }).message))) {
      throw new PdfUnsupportedEncryptionError();
    }
    throw error;
  }
  const { OPS } = engine;
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);

  return {
    pageCount: document.numPages,
    get fontsLoaded() {
      return fonts.loaded;
    },
    get fontsDenied() {
      return fonts.denied;
    },
    async pageLabels() {
      const labels = await document.getPageLabels().catch(() => null);
      return labels && labels.length === document.numPages ? labels : undefined;
    },
    async info() {
      const loaded = await document.getMetadata().catch(() => ({ info: undefined, metadata: null }));
      const info: Record<string, unknown> = loaded.info ?? {};
      const metadata = loaded.metadata;
      const result: PdfInfo = {
        encrypted: typeof info.EncryptFilterName === 'string',
        xfa: info.IsXFAPresent === true,
      };
      const title = text(info.Title);
      if (title !== undefined) result.title = title;
      const author = text(info.Author);
      if (author !== undefined) result.author = author;
      const subject = text(info.Subject);
      if (subject !== undefined) result.subject = subject;
      const created = text(info.CreationDate);
      if (created !== undefined) result.creationDate = created;
      const modified = text(info.ModDate);
      if (modified !== undefined) result.modDate = modified;
      const language = text(info.Language);
      if (language !== undefined) result.language = language;
      const xmpTitle = text(metadata?.get('dc:title'));
      if (xmpTitle !== undefined) result.xmpTitle = xmpTitle;
      const xmpCreator = text(metadata?.get('dc:creator'));
      if (xmpCreator !== undefined) result.xmpCreator = xmpCreator;
      return result;
    },
    async outline(budget) {
      const roots = await document.getOutline().catch(() => null);
      const result: PdfOutlineItem[] = [];
      // Explicit stack, outline order (SEC-8).
      const stack: Array<{ nodes: EngineOutlineNode[]; index: number; depth: number }> = [];
      if (roots) stack.push({ nodes: roots, index: 0, depth: 0 });
      while (stack.length > 0) {
        budget.tick();
        const frame = stack.at(-1)!;
        if (frame.index >= frame.nodes.length) {
          stack.pop();
          continue;
        }
        const node = frame.nodes[frame.index++]!;
        const title = text(node.title);
        if (title !== undefined) {
          const item: PdfOutlineItem = { title, depth: frame.depth };
          try {
            const destination =
              typeof node.dest === 'string' ? await document.getDestination(node.dest) : node.dest;
            const target: unknown = Array.isArray(destination) ? (destination as unknown[])[0] : undefined;
            if (typeof target === 'number') item.pageIndex = target;
            else if (target !== null && typeof target === 'object')
              item.pageIndex = await document.getPageIndex(target);
          } catch {
            // An unresolvable destination keeps the heading without a page.
          }
          result.push(item);
        }
        if (node.items && node.items.length > 0 && stack.length < budget.limits.blockDepth) {
          stack.push({ nodes: node.items, index: 0, depth: frame.depth + 1 });
        }
      }
      return result;
    },
    async hasJavaScript() {
      return hasEntries(await document.getJSActions().catch(() => null));
    },
    async hasAttachments() {
      return hasEntries(await document.getAttachments().catch(() => null));
    },
    async page(index, budget) {
      const page = await document.getPage(index + 1);
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = page.view;
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const raw of content.items as EngineTextItem[]) {
        budget.tick();
        if (typeof raw.str !== 'string' || !Array.isArray(raw.transform)) continue;
        items.push({
          text: raw.str,
          x: raw.transform[4] ?? 0,
          y: raw.transform[5] ?? 0,
          width: raw.width ?? 0,
          height: raw.height ?? Math.abs(raw.transform[3] ?? 0),
          endOfLine: raw.hasEOL === true,
          dirX: raw.transform[0] ?? 1,
          dirY: raw.transform[1] ?? 0,
          rtl: raw.dir === 'rtl',
        });
      }
      const links: PdfLink[] = [];
      const fields: PdfField[] = [];
      const fieldNames = new Set<string>();
      const notes: PdfNote[] = [];
      let hasJavaScript = hasEntries(await page.getJSActions().catch(() => null));
      for (const annotation of await page.getAnnotations().catch(() => [])) {
        budget.tick();
        if (hasEntries(annotation.actions)) hasJavaScript = true;
        if (annotation.subtype === 'Widget') {
          // One row per field: a radio group has a widget per choice. Push buttons and signatures
          // hold no value.
          const name = text(annotation.fieldName);
          if (name === undefined || annotation.pushButton === true || annotation.fieldType === 'Sig')
            continue;
          if (fieldNames.has(name)) continue;
          fieldNames.add(name);
          fields.push({ name, value: fieldValue(annotation.fieldValue, budget) });
          continue;
        }
        if (annotation.subtype === 'Text' || annotation.subtype === 'FreeText') {
          const contents = text(annotation.contentsObj?.str);
          if (contents === undefined) continue;
          const note: PdfNote = { text: contents };
          const author = text(annotation.titleObj?.str);
          if (author !== undefined) note.author = author;
          notes.push(note);
          continue;
        }
        if (annotation.subtype !== 'Link') continue;
        const rect = annotation.rect;
        const target = annotation.url ?? annotation.unsafeUrl;
        if (!target || !Array.isArray(rect) || rect.length !== 4) continue;
        const link: PdfLink = { remote: !isWebUrl(target), rect: [rect[0]!, rect[1]!, rect[2]!, rect[3]!] };
        if (!link.remote) link.url = target;
        links.push(link);
      }
      page.cleanup();
      return {
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
        items,
        links,
        fields,
        notes,
        hasJavaScript,
      };
    },
    async imageCoverage(index, budget) {
      const page = await document.getPage(index + 1);
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = page.view;
      const pageArea = Math.abs(x2 - x1) * Math.abs(y2 - y1);
      const { fnArray, argsArray } = await page.getOperatorList();
      // Track the current transformation matrix: an image fills the unit square under it.
      let matrix = [1, 0, 0, 1, 0, 0];
      const saved: number[][] = [];
      let covered = 0;
      for (let operation = 0; operation < fnArray.length; operation++) {
        budget.tick();
        const fn = fnArray[operation];
        if (fn === OPS.save) saved.push(matrix);
        else if (fn === OPS.restore) matrix = saved.pop() ?? matrix;
        else if (fn === OPS.transform) {
          const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = argsArray[operation] as number[];
          const [m0, m1, m2, m3, m4, m5] = matrix as [number, number, number, number, number, number];
          matrix = [
            m0 * a + m2 * b,
            m1 * a + m3 * b,
            m0 * c + m2 * d,
            m1 * c + m3 * d,
            m0 * e + m2 * f + m4,
            m1 * e + m3 * f + m5,
          ];
        } else if (fn !== undefined && imageOps.has(fn)) {
          covered += Math.abs(matrix[0]! * matrix[3]! - matrix[1]! * matrix[2]!);
        }
      }
      page.cleanup();
      return pageArea > 0 ? Math.min(1, covered / pageArea) : 0;
    },
    async close() {
      fonts.release();
      await task.destroy().catch(() => undefined);
    },
  };
}
