import { StrictModeError } from './errors.js';
import type { Warning, WarningCode } from './model.js';

export interface WarningSinkOptions {
  strict?: boolean | readonly WarningCode[];
}

/** Ordered warning collector shared by one extraction and its children. */
export class WarningSink {
  readonly #items: Warning[] = [];
  readonly #strict: boolean;
  readonly #codes: ReadonlySet<WarningCode>;

  constructor(options: WarningSinkOptions = {}) {
    this.#strict = options.strict === true;
    this.#codes = new Set(Array.isArray(options.strict) ? options.strict : []);
  }

  get warnings(): readonly Warning[] {
    return this.#items;
  }

  /** Store a structural warning, or throw before storing it in strict mode. */
  add(warning: Warning): void {
    if (this.#strict || this.#codes.has(warning.code)) {
      throw new StrictModeError(warning.code);
    }
    this.#items.push(warning);
  }
}
