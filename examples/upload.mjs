// Recipe: handling uploads from strangers. Tight limits, a deadline, and an HTTP answer for every error.
import { DocsluiceError, extract, toText } from 'docsluice';

/** HTTP status for each docsluice error code. */
const STATUS = new Map([
  ['UNSUPPORTED_FORMAT', 415],
  ['LIMIT_EXCEEDED', 413],
  ['ENCRYPTED', 422],
  ['CORRUPT_FILE', 422],
  ['TIMEOUT', 408],
  ['ABORTED', 499],
]);

/**
 * Extract an uploaded file for a web service. Limits are lower than the defaults: 10 MB in, 2 s of
 * work, 1 million characters out. `onLimit: 'throw'` turns a limit into an error rather than a
 * truncated document, and `metadata: false` drops author names. Errors never hold document content,
 * so their codes are safe to return.
 */
export async function handleUpload(bytes, { filename, timeoutMs = 2_000 } = {}) {
  try {
    const doc = await extract(bytes, {
      filename,
      signal: AbortSignal.timeout(timeoutMs * 2),
      limits: { inputBytes: 10 * 1024 * 1024, timeMs: timeoutMs, outputChars: 1_000_000 },
      onLimit: 'throw',
      metadata: false,
      // Nested files are listed but not read.
      children: 'list',
    });
    const flags = Object.entries(doc.features)
      .filter(([, present]) => present)
      .map(([name]) => name);
    return {
      status: 200,
      body: { format: doc.format, text: toText(doc), flags, warnings: doc.warnings.map((w) => w.code) },
    };
  } catch (error) {
    if (error instanceof DocsluiceError)
      return { status: STATUS.get(error.code) ?? 422, body: { error: error.code } };
    throw error;
  }
}
