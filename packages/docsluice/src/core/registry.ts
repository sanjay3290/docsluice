import { PluginContractError } from './errors.js';
import type { FormatId } from './model.js';
import type { Reader, ReadContext } from './reader.js';

/** The reader contract version that plugins declare (EXT-7). Plugins with another major are refused. */
export const READER_CONTRACT_VERSION = '1.0.0';

/**
 * A third-party format reader (EXT-4). It gets the same `ReadContext` as built-in readers, so it
 * reads under the caller's shared budget and limits and can use the safe zip and XML helpers.
 */
export interface FormatPlugin {
  /** Format id reported in `DocsluiceDocument.format`; it must not be a built-in id. */
  readonly id: string;
  /** Reader contract version the plugin was built for, for example `"1.0.0"`. */
  readonly contract: string;
  /** MIME types; the first is reported as the document's `mimeType`. */
  readonly mimeTypes?: readonly string[];
  /** File extensions without the dot (`["foo"]`), matched case-insensitively against `filename`. */
  readonly extensions?: readonly string[];
  /** Optional bounded probe returning a confidence from 0 to 1. */
  detect?(bytes: Uint8Array): number;
  read(ctx: ReadContext): Promise<void>;
}

function parseVersion(value: string): [number, number, number] | undefined {
  const parts = value.split('.');
  if (parts.length !== 3) return undefined;
  const numbers: number[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 9) return undefined;
    for (let index = 0; index < part.length; index++) {
      const code = part.charCodeAt(index);
      if (code < 48 || code > 57) return undefined;
    }
    numbers.push(Number(part));
  }
  return [numbers[0]!, numbers[1]!, numbers[2]!];
}

/** Refuse a plugin whose contract has another major version, or a newer minor than this one provides. */
function checkContract(plugin: FormatPlugin): void {
  const wanted = typeof plugin.contract === 'string' ? parseVersion(plugin.contract) : undefined;
  const provided = parseVersion(READER_CONTRACT_VERSION)!;
  if (!wanted || wanted[0] !== provided[0] || wanted[1] > provided[1]) {
    throw new PluginContractError(String(plugin.id), String(plugin.contract), READER_CONTRACT_VERSION);
  }
}

/** Internal registration; format modules are loaded only after format resolution. */
export interface ReaderRegistration {
  readonly id: FormatId;
  readonly mimeTypes: readonly string[];
  readonly load: () => Promise<Reader>;
}

/** A registry with per-format lazy loading, built-in readers and any registered format plugins. */
export class ReaderRegistry {
  readonly #registrations = new Map<FormatId, ReaderRegistration>();
  readonly #loaded = new Map<FormatId, Promise<Reader>>();
  readonly #plugins: FormatPlugin[] = [];

  /** Registered format plugins, in registration order. */
  get plugins(): readonly FormatPlugin[] {
    return this.#plugins;
  }

  /** Register a format plugin (EXT-4). Throws `PluginContractError` for an incompatible contract. */
  registerFormat(plugin: FormatPlugin): void {
    checkContract(plugin);
    if (typeof plugin.id !== 'string' || plugin.id.length === 0 || typeof plugin.read !== 'function') {
      throw new TypeError('A format plugin needs a string id and a read function.');
    }
    const reader: Reader = {
      id: plugin.id,
      mimeTypes: [...(plugin.mimeTypes ?? [])],
      read: (ctx) => plugin.read(ctx),
    };
    this.add({ id: plugin.id, mimeTypes: reader.mimeTypes, load: () => Promise.resolve(reader) });
    this.#plugins.push(plugin);
  }

  add(registration: ReaderRegistration): void {
    if (this.#registrations.has(registration.id)) {
      throw new TypeError('A reader is already registered for this format.');
    }
    this.#registrations.set(registration.id, registration);
  }

  load(id: FormatId): Promise<Reader> | undefined {
    const registration = this.#registrations.get(id);
    if (!registration) return undefined;
    let loading = this.#loaded.get(id);
    if (!loading) {
      loading = Promise.resolve()
        .then(registration.load)
        .then((reader) => {
          if (typeof reader.read !== 'function')
            throw new TypeError('A reader must provide a read function.');
          return reader;
        });
      this.#loaded.set(id, loading);
      void loading.catch(() => this.#loaded.delete(id));
    }
    return loading;
  }
}

/** Add the built-in readers; each format module loads only when that format is read. */
function addBuiltInReaders(registry: ReaderRegistry): void {
  registry.add({
    id: 'doc',
    mimeTypes: ['application/msword'],
    load: () => import('../readers/doc/index.js').then((module) => module.docReader),
  });
  registry.add({
    id: 'txt',
    mimeTypes: ['text/plain'],
    load: () => import('../readers/txt/index.js').then((module) => module.txtReader),
  });
  registry.add({
    id: 'markdown',
    mimeTypes: ['text/markdown', 'text/x-markdown'],
    load: () => import('../readers/markdown/index.js').then((module) => module.markdownReader),
  });
  registry.add({
    id: 'csv',
    mimeTypes: ['text/csv', 'text/comma-separated-values'],
    load: () => import('../readers/csv/index.js').then((module) => module.csvReader),
  });
  registry.add({
    id: 'tsv',
    mimeTypes: ['text/tab-separated-values'],
    load: () => import('../readers/tsv/index.js').then((module) => module.tsvReader),
  });
  registry.add({
    id: 'json',
    mimeTypes: ['application/json', 'text/json'],
    load: () => import('../readers/json/index.js').then((module) => module.jsonReader),
  });
  registry.add({
    id: 'xml',
    mimeTypes: ['application/xml', 'text/xml'],
    load: () => import('../readers/xml/index.js').then((module) => module.xmlReader),
  });
  registry.add({
    id: 'html',
    mimeTypes: ['text/html'],
    load: () => import('../readers/html/index.js').then((module) => module.htmlReader),
  });
  registry.add({
    id: 'rtf',
    mimeTypes: ['application/rtf', 'text/rtf'],
    load: () => import('../readers/rtf/index.js').then((module) => module.rtfReader),
  });
  registry.add({
    id: 'docx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    load: () => import('../readers/docx/index.js').then((module) => module.docxReader),
  });
  registry.add({
    id: 'xlsx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    load: () => import('../readers/xlsx/index.js').then((module) => module.xlsxReader),
  });
  registry.add({
    id: 'xls',
    mimeTypes: ['application/vnd.ms-excel'],
    load: () => import('../readers/xls/index.js').then((module) => module.xlsReader),
  });
  registry.add({
    id: 'pptx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    load: () => import('../readers/pptx/index.js').then((module) => module.pptxReader),
  });
  registry.add({
    id: 'odt',
    mimeTypes: ['application/vnd.oasis.opendocument.text'],
    load: () => import('../readers/odt/index.js').then((module) => module.odtReader),
  });
  registry.add({
    id: 'ods',
    mimeTypes: ['application/vnd.oasis.opendocument.spreadsheet'],
    load: () => import('../readers/ods/index.js').then((module) => module.odsReader),
  });
  registry.add({
    id: 'zip',
    mimeTypes: ['application/zip'],
    load: () => import('../readers/zip/index.js').then((module) => module.zipReader),
  });
  registry.add({
    id: 'gzip',
    mimeTypes: ['application/gzip', 'application/x-gzip'],
    load: () => import('../readers/gzip/index.js').then((module) => module.gzipReader),
  });
  registry.add({
    id: 'tar',
    mimeTypes: ['application/x-tar'],
    load: () => import('../readers/tar/index.js').then((module) => module.tarReader),
  });
  registry.add({
    id: 'eml',
    mimeTypes: ['message/rfc822'],
    load: () => import('../readers/eml/index.js').then((module) => module.emlReader),
  });
  registry.add({
    id: 'msg',
    mimeTypes: ['application/vnd.ms-outlook'],
    load: () => import('../readers/msg/index.js').then((module) => module.msgReader),
  });
  registry.add({
    id: 'epub',
    mimeTypes: ['application/epub+zip'],
    load: () => import('../readers/epub/index.js').then((module) => module.epubReader),
  });
}

/** The registry `extract()` and `detect()` use when no `registry` option is given. */
export const defaultRegistry = new ReaderRegistry();
addBuiltInReaders(defaultRegistry);

/**
 * A new registry with the built-in readers, for registering plugins without changing global state:
 * `extract(input, { registry })`.
 */
export function createRegistry(): ReaderRegistry {
  const registry = new ReaderRegistry();
  addBuiltInReaders(registry);
  return registry;
}

/** Register a format plugin on the default registry (EXT-4). */
export function registerFormat(plugin: FormatPlugin): void {
  defaultRegistry.registerFormat(plugin);
}
