// Recipe: OCR. docsluice never runs OCR itself; it hands you the image bytes that need it.
import { extract, toText } from 'docsluice';

/**
 * Extract a document and run `ocr(bytes, mimeType)` (your OCR engine or vision model) on every
 * embedded picture, or on the file itself when it is an image. `childBytes: true` keeps the
 * picture bytes on `doc.children`; image blocks point at them with `ref`.
 * `doc.stats.needsOcr` is set for pages with no text layer (scanned PDFs).
 */
export async function extractWithOcr(bytes, { filename, ocr }) {
  const doc = await extract(bytes, { filename, childBytes: true });
  const children = new Map(doc.children.map((child) => [child.path, child]));
  const recognized = [];
  const stack = [...doc.blocks];
  while (stack.length > 0) {
    const block = stack.pop();
    if (block.kind === 'section') stack.push(...block.blocks);
    if (block.kind !== 'image') continue;
    const child = block.ref === undefined ? undefined : children.get(block.ref);
    const source =
      child?.bytes ?? (doc.children.length === 0 && doc.format !== 'unknown' ? bytes : undefined);
    if (!source) continue;
    recognized.push({
      ref: block.ref,
      alt: block.alt,
      text: await ocr(source, block.mimeType ?? child?.mimeType),
    });
  }
  // Blocks were taken from the end; keep document order.
  recognized.reverse();
  return { text: toText(doc), images: recognized, needsOcr: doc.stats.needsOcr };
}
