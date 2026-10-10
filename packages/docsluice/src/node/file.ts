/// <reference types="node" />

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { extract as coreExtract } from '../core/extract.js';
import { LimitExceededError } from '../core/errors.js';
import { resolveLimits } from '../core/limits.js';
import type { DocsluiceDocument } from '../core/model.js';
import type { ExtractOptions } from '../core/options.js';

type CoreExtractor = (input: unknown, options?: ExtractOptions) => Promise<DocsluiceDocument>;
interface NodeInputDependencies {
  createReadStream: typeof createReadStream;
}

function asWebByteStream(input: Readable): ReadableStream<Uint8Array> {
  const reader = (Readable.toWeb(input) as ReadableStream<unknown>).getReader();
  let released = false;
  async function release(reason?: unknown): Promise<void> {
    if (released) return;
    released = true;
    if (reason !== undefined) {
      try {
        await reader.cancel(reason);
      } catch {
        // Preserve the original read/abort result if the underlying stream also errors on cancel.
      }
    }
    reader.releaseLock();
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          await release();
          controller.close();
        } else if (!(result.value instanceof Uint8Array)) {
          throw new TypeError('Node Readable inputs must emit byte chunks.');
        } else {
          // Buffer extends Uint8Array; copying strips the Node-specific subclass before core sees it.
          controller.enqueue(new Uint8Array(result.value));
        }
      } catch (error) {
        await release(error);
        controller.error(error);
      }
    },
    cancel: release,
  });
}

/** Create the Node boundary around a runtime-neutral extractor. Exported for Node adapter tests. */
export function createNodeExtract(
  core: CoreExtractor,
  dependencies: NodeInputDependencies = { createReadStream },
): {
  extract(input: unknown, options?: ExtractOptions): Promise<DocsluiceDocument>;
  extractFile(path: string | URL, options?: ExtractOptions): Promise<DocsluiceDocument>;
} {
  async function extract(input: unknown, options?: ExtractOptions): Promise<DocsluiceDocument> {
    if (input instanceof Readable) {
      let webInput: ReadableStream<Uint8Array> | undefined;
      try {
        webInput = asWebByteStream(input);
        return await core(webInput, options);
      } catch (error) {
        // Core can reject while resolving options, before it starts reading the converted stream.
        // Close both sides in that case, while keeping the setup/extraction error authoritative.
        try {
          input.destroy();
        } catch {
          // A custom Readable.destroy implementation must not replace the core error.
        }
        if (webInput) {
          try {
            await webInput.cancel(error);
          } catch {
            // The stream may already be locked, cancelled, or errored by the core reader.
          }
        }
        throw error;
      }
    }
    if (Buffer.isBuffer(input)) return core(new Uint8Array(input), options);
    return core(input, options);
  }

  async function extractFile(path: string | URL, options: ExtractOptions = {}): Promise<DocsluiceDocument> {
    const limits = resolveLimits(options.limits);
    const file = await stat(path);
    if (file.size > limits.inputBytes) throw new LimitExceededError('inputBytes', limits.inputBytes);

    const filename = options.filename ?? basename(path instanceof URL ? fileURLToPath(path) : path);
    return extract(dependencies.createReadStream(path), { ...options, filename });
  }

  return { extract, extractFile };
}

const nodeExtract = createNodeExtract(coreExtract);

/** Extract from Node Readable streams or the core's runtime-neutral input types. */
export const extract = (input: unknown, options?: ExtractOptions): Promise<DocsluiceDocument> =>
  nodeExtract.extract(input, options);

/** Extract a file after checking its stat size against the input limit. */
export const extractFile = (path: string | URL, options?: ExtractOptions): Promise<DocsluiceDocument> =>
  nodeExtract.extractFile(path, options);
