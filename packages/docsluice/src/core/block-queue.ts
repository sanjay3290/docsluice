import type { Block } from './model.js';

interface QueuedBlock {
  block: Block;
  consumed: Promise<void>;
  release: () => void;
}

/** One-block channel between an incremental reader and an async iterator. */
export class BlockQueue {
  readonly #items: QueuedBlock[] = [];
  #pendingNext:
    { resolve: (result: IteratorResult<Block>) => void; reject: (error: unknown) => void } | undefined;
  #closed = false;
  #failure: Error | undefined;
  #maxBuffered = 0;

  /** Internal boundedness counter for tests and diagnostics. */
  get maxBuffered(): number {
    return this.#maxBuffered;
  }

  push(block: Block): void {
    if (this.#closed) throw new TypeError('Cannot emit a block after the extraction stream has closed.');
    if (this.#pendingNext) {
      const next = this.#pendingNext;
      this.#pendingNext = undefined;
      next.resolve({ done: false, value: block });
      return;
    }
    if (this.#items.length >= 1)
      throw new TypeError('An incremental reader must await out.flush() after each emitted top-level block.');
    let release!: () => void;
    const consumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#items.push({ block, consumed, release });
    this.#maxBuffered = Math.max(this.#maxBuffered, this.#items.length);
  }

  /** Wait until the current queued block has been requested by the consumer. */
  async flush(): Promise<void> {
    const queued = this.#items[this.#items.length - 1];
    if (queued) await queued.consumed;
  }

  next(): Promise<IteratorResult<Block>> {
    const queued = this.#items.shift();
    if (queued) {
      queued.release();
      return Promise.resolve({ done: false, value: queued.block });
    }
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.#pendingNext = { resolve, reject };
    });
  }

  close(): void {
    this.#closed = true;
    this.#pendingNext?.resolve({ done: true, value: undefined });
    this.#pendingNext = undefined;
  }

  fail(error: unknown): void {
    this.#closed = true;
    this.#failure = error instanceof Error ? error : new Error('Extraction failed.');
    this.#pendingNext?.reject(this.#failure);
    this.#pendingNext = undefined;
  }
}
