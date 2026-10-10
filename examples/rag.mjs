// Recipe: RAG ingestion. One search record per chunk, with its heading path and source locations.
import { chunk, extract } from 'docsluice';

/**
 * Turn an uploaded file into records for a vector index. `countTokens` should be the embedding
 * model's tokenizer; without it, sizes are in characters.
 */
export async function toSearchRecords(bytes, { filename, maxSize = 1_000, overlap = 100, countTokens } = {}) {
  const doc = await extract(bytes, { filename, metadata: false });
  const records = [];
  for (const piece of chunk(doc, { maxSize, overlap, ...(countTokens ? { countTokens } : {}) })) {
    records.push({
      id: `${filename ?? 'document'}#${piece.index}`,
      text: piece.text,
      // "Chapter 2 › Pricing": a cheap way to give each chunk its context.
      context: piece.headingPath.join(' › '),
      // Page, sheet, slide or part of the source, for citations.
      locations: piece.locations,
    });
  }
  return { format: doc.format, records, warnings: doc.warnings.map((warning) => warning.code) };
}
