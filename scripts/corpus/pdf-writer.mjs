import { TextEncoder } from 'node:util';

// A tiny PDF writer for hand-made fixtures (ISO 32000-1, 7.5 file structure). Objects are given as
// strings; `stream()` wraps content. Produces a classic cross-reference table and trailer.

const encoder = new TextEncoder();

export function stream(content, dictionary = '') {
  const bytes = encoder.encode(content);
  return `<< ${dictionary} /Length ${bytes.length} >>\nstream\n${content}\nendstream`;
}

/** A content stream that writes `lines` in Helvetica from the top-left, one per line. */
export function textPage(lines, { size = 12, top = 760, left = 72, leading = 16 } = {}) {
  const escaped = lines.map((line) => line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)'));
  return `BT /F1 ${size} Tf ${left} ${top} Td ${leading} TL ${escaped.map((line) => `(${line}) Tj T*`).join(' ')} ET`;
}

/**
 * Build a PDF from numbered objects. `objects` is an array whose item `n - 1` is object `n`'s body;
 * `trailer` is the trailer dictionary body (for example `/Root 1 0 R /Info 9 0 R`).
 */
export function pdf(objects, trailer, { prevSelf = false } = {}) {
  let out = '%PDF-1.7\n%âãÏÓ\n';
  const parts = [encoder.encode(out)];
  let length = parts[0].length;
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(length);
    const bytes = encoder.encode(`${index + 1} 0 obj\n${body}\nendobj\n`);
    parts.push(bytes);
    length += bytes.length;
  });
  const xref = length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, '0')} 00000 n \n`;
  // `prevSelf` makes the trailer point back at its own cross-reference section (an xref loop).
  table += `trailer\n<< /Size ${objects.length + 1} ${trailer}${prevSelf ? ` /Prev ${xref}` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(encoder.encode(table));
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) {
    result.set(part, position);
    position += part.length;
  }
  return result;
}

export const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
