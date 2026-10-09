import type { FormatId } from './model.js';
import type { Reader } from './reader.js';

/** Internal registration; format modules are loaded only after format resolution. */
export interface ReaderRegistration {
  readonly id: FormatId;
  readonly mimeTypes: readonly string[];
  readonly load: () => Promise<Reader>;
}

/** A registry with per-format lazy loading. Public plugin registration is a separate API. */
export class ReaderRegistry {
  readonly #registrations = new Map<FormatId, ReaderRegistration>();
  readonly #loaded = new Map<FormatId, Promise<Reader>>();

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

/** Built-in registrations are added as the corresponding readers become available. */
export const defaultRegistry = new ReaderRegistry();
defaultRegistry.add({
  id: 'doc',
  mimeTypes: ['application/msword'],
  load: () => import('../readers/doc/index.js').then((module) => module.docReader),
});
