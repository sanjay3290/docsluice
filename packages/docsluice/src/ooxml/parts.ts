import type { XmlContext } from '../xml/index.js';
import type { ZipArchive, ZipEntry } from '../zip/index.js';

function warnUnreadable(ctx: XmlContext): void {
  ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'An OOXML part could not be read.' });
}

function foldAscii(value: string, ctx: XmlContext): string {
  let folded = '';
  for (let index = 0; index < value.length; index += 1) {
    ctx.budget.tick();
    const code = value.charCodeAt(index);
    folded += String.fromCharCode(code >= 65 && code <= 90 ? code + 32 : code);
  }
  return folded;
}

/** A bounded, name-only view over a ZIP archive's OOXML parts. */
export class OoxmlParts {
  readonly #archive: ZipArchive;
  readonly #ctx: XmlContext;
  readonly #exact = new Map<string, ZipEntry[]>();
  readonly #folded = new Map<string, ZipEntry[]>();
  readonly #warned = new Set<string>();

  constructor(archive: ZipArchive, ctx: XmlContext) {
    this.#archive = archive;
    this.#ctx = ctx;
    for (const entry of archive.entries) {
      ctx.budget.tick();
      const exact = this.#exact.get(entry.name) ?? [];
      exact.push(entry);
      this.#exact.set(entry.name, exact);
      const key = foldAscii(entry.name, ctx);
      const folded = this.#folded.get(key) ?? [];
      folded.push(entry);
      this.#folded.set(key, folded);
    }
    for (const [name, entries] of this.#exact) {
      ctx.budget.tick();
      if (entries.length > 1) this.#warn(name);
    }
  }

  find(name: string): ZipEntry | undefined {
    for (let index = 0; index < name.length; index += 1) this.#ctx.budget.tick();
    const exact = this.#exact.get(name);
    if (exact) return exact.length === 1 && !exact[0]!.isUnreadable ? exact[0] : this.#ambiguous(name);
    const folded = this.#folded.get(foldAscii(name, this.#ctx));
    if (!folded) return undefined;
    if (folded.length !== 1 || folded[0]!.isUnreadable) return this.#ambiguous(name);
    return folded[0];
  }

  async read(name: string): Promise<Uint8Array | undefined> {
    const entry = this.find(name);
    if (!entry) return undefined;
    const content = await this.#archive.read(entry);
    if (content === null) {
      this.#warn(name);
      return undefined;
    }
    return content;
  }

  #ambiguous(name: string): undefined {
    this.#warn(name);
    return undefined;
  }

  #warn(name: string): void {
    if (this.#warned.has(name)) return;
    this.#warned.add(name);
    warnUnreadable(this.#ctx);
  }
}
