import { Budget, setBudgetWarnings } from './budget.js';
import { DocBuilder } from './builder.js';
import {
  AbortError,
  CorruptFileError,
  DocsluiceError,
  TimeoutError,
  UnsupportedFormatError,
} from './errors.js';
import { readInput } from './input.js';
import { resolveLimits } from './limits.js';
import type { Block, ChildDocument, DocsluiceDocument, Location, Warning } from './model.js';
import type { ExtractOptions, ResolvedOptions } from './options.js';
import type { ReadContext } from './reader.js';
import { defaultRegistry } from './registry.js';
import type { ReaderRegistry } from './registry.js';
import { WarningSink } from './warnings.js';
import { assignOffsets } from '../render/text.js';
import { resolveFormatWithRegistry } from './resolve-reader.js';

const EMPTY_FORMATS = new Set(['png', 'jpeg', 'gif', 'tiff', 'webp', 'bmp', 'ico', 'audio', 'video']);
const MAX_TIMER_DELAY = 2_147_483_647;

/** Snapshot caller options once, including every safe default. */
export function resolveOptions(options: ExtractOptions = {}): ResolvedOptions {
  return Object.freeze({
    ...options,
    limits: Object.freeze(resolveLimits(options.limits)),
    strict: Array.isArray(options.strict) ? Object.freeze([...options.strict]) : (options.strict ?? false),
    onLimit: options.onLimit ?? 'truncate',
    metadata: options.metadata ?? true,
    imageGps: options.imageGps ?? false,
    children: options.children ?? 'extract',
    childBytes: options.childBytes ?? false,
    runs: options.runs ?? false,
    revisions: options.revisions ?? 'accept',
    includeHidden: options.includeHidden ?? false,
    formulas: options.formulas ?? false,
  });
}

interface Ancestor {
  bytes: Uint8Array;
  hash: number;
}

interface Job {
  bytes: Uint8Array;
  options: ResolvedOptions;
  budget: Budget;
  path: string;
  ancestors: readonly Ancestor[];
  warnings: ReaderWarnings;
  resolve: (document: DocsluiceDocument) => void;
  reject: (error: unknown) => void;
}

function prefixLocation(location: Location, path: string): Location {
  if (!path) return location;
  const existing = location.path;
  if (existing === path || existing?.startsWith(path + '/')) return location;
  return { ...location, path: existing ? path + '/' + existing.replace(/^\/+/, '') : path };
}

/** Forward reader warnings into the one shared sink with the child's path. */
class ReaderWarnings extends WarningSink {
  readonly #items: Warning[] = [];
  constructor(
    readonly shared: WarningSink,
    readonly path: string,
    readonly budget: Budget,
  ) {
    super();
  }

  override get warnings(): readonly Warning[] {
    return this.#items;
  }

  override add(warning: Warning): void {
    const scoped = this.path ? { ...warning, loc: prefixLocation(warning.loc ?? {}, this.path) } : warning;
    let root: WarningSink = this.shared;
    while (root instanceof ReaderWarnings) {
      this.budget.tick();
      root = root.shared;
    }
    root.add(scoped);
    this.#items.push(scoped);
    let current: WarningSink = this.shared;
    while (current instanceof ReaderWarnings) {
      this.budget.tick();
      current.#items.push(scoped);
      current = current.shared;
    }
  }
}

function prefixBlocks(blocks: readonly Block[], path: string, budget: Budget): void {
  const frames: Array<{ blocks: readonly Block[]; index: number }> = [{ blocks, index: 0 }];
  while (frames.length > 0) {
    budget.tick();
    const frame = frames[frames.length - 1]!;
    if (frame.index >= frame.blocks.length) {
      frames.pop();
      continue;
    }
    const block = frame.blocks[frame.index++]!;
    block.loc = prefixLocation(block.loc, path);
    if (block.kind === 'section') frames.push({ blocks: block.blocks, index: 0 });
  }
}

function fingerprint(bytes: Uint8Array, budget: Budget): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    budget.tick();
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
}

function containsAncestor(
  bytes: Uint8Array,
  hash: number,
  ancestors: readonly Ancestor[],
  budget: Budget,
): boolean {
  for (const ancestor of ancestors) {
    budget.tick();
    if (ancestor.hash !== hash || ancestor.bytes.length !== bytes.length) continue;
    let equal = true;
    for (let index = 0; index < bytes.length; index++) {
      budget.tick();
      if (ancestor.bytes[index] !== bytes[index]) {
        equal = false;
        break;
      }
    }
    if (equal) return true;
  }
  return false;
}

function childOptions(parent: ResolvedOptions, name: string, hint?: { mimeType?: string }): ResolvedOptions {
  // A parent's forced format and MIME label describe that parent, not its attachments.
  const resolved = { ...parent, filename: name };
  delete resolved.format;
  delete resolved.mimeType;
  if (hint?.mimeType !== undefined) resolved.mimeType = hint.mimeType;
  return Object.freeze(resolved);
}

function childFailure(error: unknown): ChildDocument['error'] {
  return {
    code: error instanceof DocsluiceError ? error.code : 'CORRUPT_FILE',
    message: 'The child document could not be read.',
  };
}

/** Build an extractor against an internal registry, used by pipeline and plugin tests. */
export function createExtractor(
  registry: ReaderRegistry,
): (input: unknown, options?: ExtractOptions) => Promise<DocsluiceDocument> {
  return async (input, options = {}) => {
    const resolved = resolveOptions(options);
    const startedAt = performance.now();
    const cancellation = new AbortController();
    const warnings = new WarningSink({ strict: resolved.strict });
    const budget = new Budget(resolved.limits, {
      onLimit: resolved.onLimit,
      signal: cancellation.signal,
      warnings,
    });
    const jobs: Job[] = [];
    let dispatchScheduled = false;

    function enqueue(
      bytes: Uint8Array,
      activeOptions: ResolvedOptions,
      activeBudget: Budget,
      path: string,
      ancestors: readonly Ancestor[],
      warningParent: WarningSink,
    ): Promise<DocsluiceDocument> {
      const result = new Promise<DocsluiceDocument>((resolve, reject) => {
        jobs.push({
          bytes,
          options: activeOptions,
          budget: activeBudget,
          path,
          ancestors,
          warnings: new ReaderWarnings(warningParent, path, activeBudget),
          resolve,
          reject,
        });
      });
      if (!dispatchScheduled) {
        dispatchScheduled = true;
        queueMicrotask(dispatch);
      }
      return result;
    }

    function dispatch(): void {
      dispatchScheduled = false;
      // Child work is queued, so traversing nested files never grows the JavaScript call stack.
      const queued = jobs.splice(0);
      for (const job of queued) {
        void readDocument(job).then(job.resolve, job.reject);
      }
    }

    async function readDocument(job: Job): Promise<DocsluiceDocument> {
      const { bytes, budget: activeBudget, options: activeOptions, path } = job;
      activeBudget.tick();
      const readerWarnings = job.warnings;
      setBudgetWarnings(activeBudget, readerWarnings);
      const activeRegistry = activeOptions.registry ?? registry;
      const resolution = await resolveFormatWithRegistry(bytes, activeOptions, activeBudget, activeRegistry);
      const out = new DocBuilder(
        resolution.result.format,
        resolution.result.mimeType,
        activeBudget,
        activeOptions,
      );
      if (resolution.result.encoding) out.setEncoding(resolution.result.encoding);
      const children: Array<Promise<void>> = [];
      let ancestorHash: number | undefined;

      const ctx: ReadContext = {
        bytes,
        ...(activeOptions.filename !== undefined ? { filename: activeOptions.filename } : {}),
        options: activeOptions,
        budget: activeBudget,
        warnings: readerWarnings,
        out,
        path,
        ...(resolution.zip ? { zip: resolution.zip } : {}),
        ...(resolution.cfb ? { cfb: resolution.cfb } : {}),
        extractChild(name, childBytes, hint): Promise<void> {
          activeBudget.tick();
          if (activeOptions.children === 'skip') return Promise.resolve();
          const childPath = path ? path + '/' + name : name;
          const child: ChildDocument = {
            path: childPath,
            name,
            status: 'listed',
            sizeBytes: childBytes.length,
            ...(hint?.mimeType ? { mimeType: hint.mimeType } : {}),
            ...(activeOptions.childBytes ? { bytes: childBytes } : {}),
          };
          const work = (async (): Promise<ChildDocument> => {
            if (activeOptions.children === 'list') return child;
            let childBudget: Budget;
            try {
              childBudget = activeBudget.child();
              if (!childBudget.canRead) return child;
              ancestorHash ??= fingerprint(bytes, activeBudget);
              const ancestors = [...job.ancestors, { bytes, hash: ancestorHash }];
              const hash = fingerprint(childBytes, childBudget);
              if (containsAncestor(childBytes, hash, ancestors, childBudget)) {
                readerWarnings.add({
                  code: 'DEPTH_LIMIT',
                  message: 'An ancestor-identical child was listed without being opened.',
                  loc: { path: childPath },
                });
                return child;
              }
              child.document = await enqueue(
                childBytes,
                childOptions(activeOptions, name, hint),
                childBudget,
                childPath,
                ancestors,
                readerWarnings,
              );
              child.status = 'extracted';
              child.mimeType = child.document.mimeType;
              return child;
            } catch (error) {
              // Cancellation and elapsed time belong to the whole extraction, not one attachment.
              if (error instanceof AbortError || error instanceof TimeoutError) throw error;
              child.status = 'failed';
              child.error = childFailure(error);
              return child;
            }
          })();
          const previous = children[children.length - 1];
          const ordered = previous ? previous.then(() => work) : work;
          const done = ordered.then((child) => {
            if (child) out.addChild(child);
          });
          children.push(done);
          // Readers should await child work; handle fire-and-forget cancellation as well.
          void done.catch(() => undefined);
          void work.catch(() => undefined);
          return done;
        },
      };

      const loading = activeRegistry.load(resolution.result.format);
      if (loading) {
        const reader = await loading;
        activeBudget.tick();
        try {
          await reader.read(ctx);
        } catch (error) {
          if (error instanceof DocsluiceError) throw error;
          throw new CorruptFileError(undefined, { cause: error });
        }
      } else if (!EMPTY_FORMATS.has(resolution.result.format)) {
        throw new UnsupportedFormatError(resolution.result.format);
      }
      for (const childWork of children) {
        activeBudget.tick();
        await childWork;
      }
      activeBudget.tick();
      const document = out.finish();
      prefixBlocks(document.blocks, path, activeBudget);
      assignOffsets(document, activeBudget);
      document.stats.bytesRead = bytes.length;
      document.stats.durationMs = performance.now() - startedAt;
      return document;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectStopped!: (error: AbortError | TimeoutError) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStopped = reject;
    });
    const stop = (error: AbortError | TimeoutError): void => {
      rejectStopped(error);
      cancellation.abort();
    };
    const onAbort = (): void => stop(new AbortError());
    const checkTime = (): void => {
      const remaining = resolved.limits.timeMs - (performance.now() - startedAt);
      if (remaining < 0) stop(new TimeoutError(resolved.limits.timeMs));
      else timer = setTimeout(checkTime, Math.min(MAX_TIMER_DELAY, remaining + 1));
    };
    if (resolved.signal?.aborted) onAbort();
    else resolved.signal?.addEventListener('abort', onAbort, { once: true });
    checkTime();
    const running = (async (): Promise<DocsluiceDocument> => {
      const bytes = await readInput(input, budget);
      return enqueue(bytes, resolved, budget, '', [], warnings);
    })();
    try {
      return await Promise.race([running, stopped]);
    } finally {
      // Close the private scope on success or failure; pending child work cannot outlive extraction.
      cancellation.abort();
      if (timer !== undefined) clearTimeout(timer);
      resolved.signal?.removeEventListener('abort', onAbort);
    }
  };
}

/**
 * Extract structured document content from web-standard bytes, blobs and streams.
 * Readers load on demand; children share byte, output and time allowances.
 */
export const extract = createExtractor(defaultRegistry);
