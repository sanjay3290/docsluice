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
  /** Plugins record theirs; built-in MIME types live in the detection tables (`detect/mime.ts`). */
  readonly mimeTypes?: readonly string[];
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
  // Macro-enabled files share the plain reader's module.
  const loadPptx = () => import('../readers/pptx/index.js').then((module) => module.pptxReader);
  const loadXlsx = () => import('../readers/xlsx/index.js').then((module) => module.xlsxReader);
  const loadDocx = () => import('../readers/docx/index.js').then((module) => module.docxReader);
  // One image reader for every image format: size and EXIF metadata, no text.
  const loadImage = () => import('../readers/image/index.js').then((module) => module.imageReader);
  // Audio and video container metadata share one module (#248).
  const loadAudio = () => import('../readers/media/index.js').then((module) => module.audioReader);
  const loadVideo = () => import('../readers/media/index.js').then((module) => module.videoReader);
  // Each format module loads only when that format is read.
  const builtIns: Array<[FormatId, () => Promise<Reader>]> = [
    ['doc', () => import('../readers/doc/index.js').then((module) => module.docReader)],
    ['vsdx', () => import('../readers/vsdx/index.js').then((module) => module.vsdxReader)],
    ['ppt', () => import('../readers/ppt/index.js').then((module) => module.pptReader)],
    ['txt', () => import('../readers/txt/index.js').then((module) => module.txtReader)],
    ['markdown', () => import('../readers/markdown/index.js').then((module) => module.markdownReader)],
    ['csv', () => import('../readers/csv/index.js').then((module) => module.csvReader)],
    ['tsv', () => import('../readers/tsv/index.js').then((module) => module.tsvReader)],
    ['json', () => import('../readers/json/index.js').then((module) => module.jsonReader)],
    ['yaml', () => import('../readers/yaml/index.js').then((module) => module.yamlReader)],
    ['ndjson', () => import('../readers/ndjson/index.js').then((module) => module.ndjsonReader)],
    ['ics', () => import('../readers/ics/index.js').then((module) => module.icsReader)],
    ['vcf', () => import('../readers/vcf/index.js').then((module) => module.vcfReader)],
    ['srt', () => import('../readers/srt/index.js').then((module) => module.srtReader)],
    ['vtt', () => import('../readers/vtt/index.js').then((module) => module.vttReader)],
    ['xml', () => import('../readers/xml/index.js').then((module) => module.xmlReader)],
    ['html', () => import('../readers/html/index.js').then((module) => module.htmlReader)],
    ['rtf', () => import('../readers/rtf/index.js').then((module) => module.rtfReader)],
    ['docx', loadDocx],
    ['docm', loadDocx],
    ['xlsx', loadXlsx],
    ['xlsm', loadXlsx],
    ['xlsb', () => import('../readers/xlsb/index.js').then((module) => module.xlsbReader)],
    ['xls', () => import('../readers/xls/index.js').then((module) => module.xlsReader)],
    ['pptx', loadPptx],
    ['pptm', loadPptx],
    ['odt', () => import('../readers/odt/index.js').then((module) => module.odtReader)],
    ['ods', () => import('../readers/ods/index.js').then((module) => module.odsReader)],
    ['odp', () => import('../readers/odp/index.js').then((module) => module.odpReader)],
    ['zip', () => import('../readers/zip/index.js').then((module) => module.zipReader)],
    ['gzip', () => import('../readers/gzip/index.js').then((module) => module.gzipReader)],
    ['tar', () => import('../readers/tar/index.js').then((module) => module.tarReader)],
    ['eml', () => import('../readers/eml/index.js').then((module) => module.emlReader)],
    ['mbox', () => import('../readers/mbox/index.js').then((module) => module.mboxReader)],
    ['msg', () => import('../readers/msg/index.js').then((module) => module.msgReader)],
    ['epub', () => import('../readers/epub/index.js').then((module) => module.epubReader)],
  ];
  for (const id of ['png', 'jpeg', 'gif', 'tiff', 'webp']) builtIns.push([id, loadImage]);
  builtIns.push(['audio', loadAudio], ['video', loadVideo]);
  for (const [id, load] of builtIns) registry.add({ id, load });
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
