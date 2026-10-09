import type { Block, DocsluiceDocument } from './model.js';
import type { ExtractOptions } from './options.js';
import { BlockQueue } from './block-queue.js';

/** The result promise is available alongside the block iterator. */
export interface AsyncBlockStream extends AsyncIterable<Block> {
  readonly result: Promise<DocsluiceDocument>;
}

/** Internal controls passed to the shared extraction pipeline for an incremental iterator. */
export interface StreamExecution {
  readonly channel: BlockQueue;
  readonly abortSignal: AbortSignal;
  readonly setMode: (incremental: boolean) => void;
}

type Runner = (
  input: unknown,
  options: ExtractOptions,
  execution?: StreamExecution,
) => Promise<DocsluiceDocument>;

/**
 * Create a lazy block iterator. Accessing `.result` alone runs the ordinary extraction path;
 * iterating first enables incremental readers and backpressure.
 */
export function createBlockStream(input: unknown, options: ExtractOptions, run: Runner): AsyncBlockStream {
  const controller = new AbortController();
  const channel = new BlockQueue();
  let started = false;
  let modeSet = false;
  let incremental = false;
  let resolveMode!: (value: boolean) => void;
  const mode = new Promise<boolean>((resolve) => {
    resolveMode = resolve;
  });
  let result: Promise<DocsluiceDocument> | undefined;

  const setMode = (value: boolean): void => {
    if (modeSet) return;
    modeSet = true;
    incremental = value;
    resolveMode(value);
  };
  const start = (enableStreaming: boolean): void => {
    if (started) return;
    started = true;
    if (!enableStreaming) setMode(false);
    const execution = enableStreaming ? { channel, abortSignal: controller.signal, setMode } : undefined;
    result = run(input, options, execution);
    void result.then(
      () => {
        setMode(false);
        channel.close();
      },
      (error: unknown) => {
        setMode(false);
        channel.fail(error);
      },
    );
    // `.result` may be the only observed member; avoid an unhandled rejection in that case.
    void result.catch(() => undefined);
  };

  const stream: AsyncBlockStream = {
    get result(): Promise<DocsluiceDocument> {
      start(false);
      return result!;
    },
    [Symbol.asyncIterator](): AsyncIterator<Block> {
      start(true);
      const iterate = async function* (): AsyncGenerator<Block> {
        try {
          const useIncremental = await mode;
          if (useIncremental) {
            while (true) {
              const next = await channel.next();
              if (next.done) break;
              yield next.value;
            }
          } else {
            const document = await result!;
            for (const block of document.blocks) yield block;
          }
        } finally {
          if (incremental) controller.abort();
        }
      };
      return iterate();
    },
  };
  return stream;
}
