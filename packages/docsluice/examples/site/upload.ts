import { extract } from '../../src/index.js';

const MAX_UPLOAD_BYTES = 25_000_000;

/** Extract a browser File without writing it to disk; the library enforces the input and time budgets. */
export async function extractUploadedFile(file: File) {
  if (file.size > MAX_UPLOAD_BYTES) throw new RangeError('Upload exceeds the 25 MB application limit.');
  return extract(new Uint8Array(await file.arrayBuffer()), {
    filename: file.name,
    mimeType: file.type || undefined,
    limits: { inputBytes: MAX_UPLOAD_BYTES, timeMs: 15_000 },
    metadata: false,
    children: 'list',
  });
}
