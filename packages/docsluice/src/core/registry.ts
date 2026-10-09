import type { ExtractOptions } from './options.js';
import type { FormatId } from './model.js';
import type { ReadContext, Reader } from './reader.js';
import { PluginContractError } from './errors.js';

/** Current version of the public reader context supplied to format plugins. */
export const READER_CONTRACT_VERSION = '1.0.0';

/** A third-party reader registered on an isolated format registry. */
export interface FormatPlugin {
  readonly id: FormatId;
  readonly mimeTypes: readonly string[];
  /** Optional inexpensive content probe. Return confidence from zero to one. */
  readonly detect?: (bytes: Uint8Array) => number;
  readonly read: (ctx: ReadContext) => Promise<void>;
  /** Semver version of the reader context contract the plugin was built against. */
  readonly contract: string;
}

/** Internal registration; format modules are loaded only after format resolution. */
export interface ReaderRegistration {
  readonly id: FormatId;
  readonly mimeTypes: readonly string[];
  readonly load: () => Promise<Reader>;
  readonly plugin?: boolean;
  readonly detect?: (bytes: Uint8Array) => number;
}

export interface PluginSelection {
  readonly id: FormatId;
  readonly mimeType: string;
  readonly confidence: number;
}

const BUILTIN_CONFIDENCE = 0.8;
const PLUGIN_CONFIDENCE = 0.5;
const FORMAT_ID = /^[a-z][\w.-]*$/;
const MIME_TYPE = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;
const SEMVER =
  /^(0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}(?:-([a-z\d-]+(?:\.[a-z\d-]+)*))?(?:\+[a-z\d-]+(?:\.[a-z\d-]+)*)?$/i;

export interface PluginProbeResult {
  readonly selection?: PluginSelection;
  readonly ambiguous: boolean;
}

/**
 * A registry with per-format lazy loading and isolated plugin registration.
 * Create public registries with {@link createRegistry} so each includes built-ins.
 */
export class ReaderRegistry {
  readonly #registrations = new Map<FormatId, ReaderRegistration>();
  readonly #loaded = new Map<FormatId, Promise<Reader>>();

  add(registration: ReaderRegistration): void {
    if (this.#registrations.has(registration.id)) {
      throw new TypeError('A reader is already registered for this format.');
    }
    this.#registrations.set(registration.id, registration);
  }

  /** Register a format plugin after checking its public contract and descriptor. */
  registerFormat(value: FormatPlugin): void {
    let id: unknown;
    let mimeTypes: unknown;
    let detect: unknown;
    let read: unknown;
    let contract: unknown;
    try {
      id = value?.id;
      mimeTypes = value?.mimeTypes;
      detect = value?.detect;
      read = value?.read;
      contract = value?.contract;
    } catch {
      throw new TypeError('A format plugin descriptor could not be read.');
    }

    if (typeof id !== 'string' || id.length > 128 || !FORMAT_ID.test(id) || id.toLowerCase() !== id) {
      throw new TypeError('A format plugin must provide a valid format id.');
    }
    try {
      const validMimeTypes =
        Array.isArray(mimeTypes) &&
        mimeTypes.length > 0 &&
        mimeTypes.length <= 64 &&
        mimeTypes.every(
          (mimeType) => typeof mimeType === 'string' && mimeType.length <= 255 && MIME_TYPE.test(mimeType),
        );
      if (!validMimeTypes) throw new TypeError('Invalid MIME types.');
    } catch {
      throw new TypeError('A format plugin must provide one or more valid MIME types.');
    }
    if (detect !== undefined && typeof detect !== 'function') {
      throw new TypeError('A format plugin detect value must be a function.');
    }
    if (typeof read !== 'function') {
      throw new TypeError('A format plugin must provide a read function.');
    }
    if (typeof contract !== 'string' || contract.length > 128) {
      throw new TypeError('A format plugin must provide a reader contract version.');
    }
    const version = SEMVER.exec(contract);
    if (!version) throw new TypeError('A format plugin contract version must be valid semver.');
    const prerelease = version[2];
    if (
      prerelease
        ?.split('.')
        .some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === '0')
    ) {
      throw new TypeError('A format plugin contract version must be valid semver.');
    }
    if (version[1] !== READER_CONTRACT_VERSION.split('.')[0]) {
      throw new PluginContractError();
    }

    const idValue = id;
    let mimeValues: readonly string[];
    try {
      mimeValues = Object.freeze((mimeTypes as string[]).slice());
    } catch {
      throw new TypeError('A format plugin must provide one or more valid MIME types.');
    }
    const reader: Reader = {
      id: idValue,
      mimeTypes: mimeValues,
      ...(typeof detect === 'function' ? { detect: detect as (bytes: Uint8Array) => number } : {}),
      read: read as (ctx: ReadContext) => Promise<void>,
    };
    this.add({
      id: idValue,
      mimeTypes: mimeValues,
      ...(typeof detect === 'function' ? { detect: detect as (bytes: Uint8Array) => number } : {}),
      plugin: true,
      load: () => Promise.resolve(reader),
    });
  }

  /** Select one plugin only when core detection is uncertain and its probe is confident. */
  selectPlugin(
    bytes: Uint8Array,
    options: Pick<ExtractOptions, 'filename' | 'mimeType'>,
    confidence: number,
  ): PluginSelection | undefined {
    return this.resolvePlugin(bytes, options, confidence).selection;
  }

  /** Probe eligible plugins and report tied confident matches without choosing arbitrarily. */
  resolvePlugin(
    bytes: Uint8Array,
    options: Pick<ExtractOptions, 'filename' | 'mimeType'>,
    confidence: number,
  ): PluginProbeResult {
    if (confidence >= BUILTIN_CONFIDENCE) return { ambiguous: false };
    const extension = filenameExtension(options.filename);
    const matches: PluginSelection[] = [];
    for (const registration of this.#registrations.values()) {
      if (!registration.plugin) continue;
      const hintedMime = options.mimeType?.toLowerCase();
      const matchingMime = hintedMime
        ? registration.mimeTypes.find((mimeType) => mimeType.toLowerCase() === hintedMime)
        : undefined;
      const hintMatches = matchingMime !== undefined || extension === registration.id;
      let detected: number;
      if (registration.detect) {
        try {
          detected = registration.detect(bytes);
        } catch {
          throw new TypeError('A format plugin detect function failed.');
        }
        if (!Number.isFinite(detected) || detected < 0 || detected > 1) {
          throw new TypeError('A format plugin detect function must return a confidence from zero to one.');
        }
      } else {
        detected = hintMatches ? 1 : 0;
      }
      const threshold = hintMatches ? PLUGIN_CONFIDENCE : Math.max(PLUGIN_CONFIDENCE, confidence);
      if (detected <= threshold) continue;
      matches.push({
        id: registration.id,
        mimeType: matchingMime ?? registration.mimeTypes[0]!,
        confidence: detected,
      });
    }
    if (matches.length === 0) return { ambiguous: false };
    matches.sort((left, right) => right.confidence - left.confidence);
    if (matches[1]?.confidence === matches[0]?.confidence) return { ambiguous: true };
    return { selection: matches[0], ambiguous: false };
  }

  hasPluginHint(options: Pick<ExtractOptions, 'filename' | 'mimeType'>): boolean {
    const extension = filenameExtension(options.filename);
    const hintedMime = options.mimeType?.toLowerCase();
    for (const registration of this.#registrations.values()) {
      if (!registration.plugin) continue;
      if (extension === registration.id) return true;
      if (hintedMime && registration.mimeTypes.some((mimeType) => mimeType.toLowerCase() === hintedMime)) {
        return true;
      }
    }
    return false;
  }

  pluginMimeType(id: FormatId, hint?: string): string | undefined {
    const registration = this.#registrations.get(id);
    if (!registration?.plugin) return undefined;
    const hinted = hint?.toLowerCase();
    return (
      registration.mimeTypes.find((mimeType) => mimeType.toLowerCase() === hinted) ??
      registration.mimeTypes[0]
    );
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

function filenameExtension(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const pathSeparator = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const dot = filename.lastIndexOf('.');
  if (dot <= pathSeparator + 0 || dot === filename.length - 1) return undefined;
  return filename.slice(dot + 1).toLowerCase();
}

function addBuiltins(registry: ReaderRegistry): void {
  registry.add({
    id: 'doc',
    mimeTypes: ['application/msword'],
    load: () => import('../readers/doc/index.js').then((module) => module.docReader),
  });
}

/** Create an isolated registry that starts with the lazy built-in readers. */
export function createRegistry(): ReaderRegistry {
  const registry = new ReaderRegistry();
  addBuiltins(registry);
  return registry;
}

/** Register a format plugin on the shared default registry. */
export function registerFormat(plugin: FormatPlugin): void {
  defaultRegistry.registerFormat(plugin);
}

/** The default registry used by {@link extract}. */
export const defaultRegistry = createRegistry();
