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
  hasJavaScript: boolean;
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

// Minimal shapes of the pdf.js objects used here.
interface EngineTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}
interface EngineAnnotation {
  subtype?: string;
  url?: string;
  unsafeUrl?: string;
  rect?: number[];
  actions?: Record<string, unknown>;
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
interface EngineModule {
  getDocument(options: Record<string, unknown>): {
    promise: Promise<EngineDocument>;
    destroy(): Promise<void>;
  };
  OPS: Record<string, number>;
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

function hasEntries(value: Record<string, unknown> | null | undefined): boolean {
  return value !== null && value !== undefined && Object.keys(value).length > 0;
}

/** Open a PDF with the engine. Password-protected files throw `PdfPasswordError`. */
export async function openPdf(bytes: Uint8Array, password: string | undefined): Promise<PdfDocument> {
  const engine = await loadEngine();
  // pdf.js may transfer the buffer; give it a copy so the caller's bytes stay intact.
  const task = engine.getDocument({
    data: bytes.slice(),
    ...ENGINE_OPTIONS,
    ...(password !== undefined ? { password } : {}),
  });
  let document: EngineDocument;
  try {
    document = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => undefined);
    const name = (error as { name?: unknown }).name;
    if (name === 'PasswordException') {
      const code = (error as { code?: unknown }).code;
      throw new PdfPasswordError(code === 2);
    }
    throw error;
  }
  const { OPS } = engine;
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);

  return {
    pageCount: document.numPages,
    async pageLabels() {
      const labels = await document.getPageLabels().catch(() => null);
      return labels && labels.length === document.numPages ? labels : undefined;
    },
    async info() {
      const loaded = await document.getMetadata().catch(() => ({ info: undefined, metadata: null }));
      const info: Record<string, unknown> = loaded.info ?? {};
      const metadata = loaded.metadata;
      const result: PdfInfo = {};
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
        });
      }
      const links: PdfLink[] = [];
      let hasJavaScript = hasEntries(await page.getJSActions().catch(() => null));
      for (const annotation of await page.getAnnotations().catch(() => [])) {
        budget.tick();
        if (hasEntries(annotation.actions)) hasJavaScript = true;
        if (annotation.subtype !== 'Link') continue;
        const rect = annotation.rect;
        const target = annotation.url ?? annotation.unsafeUrl;
        if (!target || !Array.isArray(rect) || rect.length !== 4) continue;
        const link: PdfLink = { remote: !isWebUrl(target), rect: [rect[0]!, rect[1]!, rect[2]!, rect[3]!] };
        if (!link.remote) link.url = target;
        links.push(link);
      }
      page.cleanup();
      return { width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), items, links, hasJavaScript };
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
      await task.destroy().catch(() => undefined);
    },
  };
}
