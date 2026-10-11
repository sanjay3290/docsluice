export function patchPdfJs(source) {
  const site =
    /this\.toplevelPagesDict&&([A-Za-z_$][\w$]*) instanceof ([A-Za-z_$][\w$]*)&&!([A-Za-z_$][\w$]*)\.has\(\1\)&&\3\.put\(\1,([A-Za-z_$][\w$]*)\.fetchAsync\(\1\)\)/g;
  const matches = [...source.matchAll(site)];
  if (matches.length !== 1)
    throw new Error(`The pdf.js page-kids prefetch patch must match exactly once; found ${matches.length}.`);
  const match = matches[0];
  const [original, kid, ref, cache, xref] = match;
  const replacement = `this.toplevelPagesDict&&${kid} instanceof ${ref}&&!${cache}.has(${kid})&&${cache}.put(${kid},docsluicePdfPrefetch(${xref}.fetchAsync(${kid})))`;
  const indexSite =
    /\.push\(([A-Za-z_$][\w$]*)\.fetchAsync\(([A-Za-z_$][\w$]*)\)\.then\(([A-Za-z_$][\w$]*)=>\{if\(!\(\3 instanceof ([A-Za-z_$][\w$]*)\)\)throw new ([A-Za-z_$][\w$]*)\(`Kid node must be a dictionary\.`\);if\(\3\.has\(`Count`\)\)\{let ([A-Za-z_$][\w$]*)=\3\.get\(`Count`\);if\(Number\.isInteger\(\6\)&&\6>=0\)\{([A-Za-z_$][\w$]*)\+=\6;return\}throw new \5\(`Count must be a \(positive\) integer\.`\)\}\7\+\+\}\)\)/g;
  const indexMatches = [...source.matchAll(indexSite)];
  if (indexMatches.length !== 1)
    throw new Error(
      `The pdf.js page-index prefetch patch must match exactly once; found ${indexMatches.length}.`,
    );
  const notice = `/*! pdf.js 6.1.200: Copyright Mozilla Foundation. Apache-2.0.
 * unpdf 1.8.1: Copyright (c) 2023-PRESENT Johann Schopplich. MIT.
 * Modified by docsluice: observe page-tree prefetch rejections (#206, #261).
 * Full license texts: THIRD_PARTY_NOTICES.md.
 */\n`;
  return (
    notice +
    source
      // Function replacements: a `$` in a minified name must not act as a replacement pattern.
      .replace(original, () => replacement)
      .replace(indexSite, (call) => `.push(docsluicePdfPrefetch(${call.slice('.push('.length, -1)}))`) +
    '\nfunction docsluicePdfPrefetch(promise) { promise.catch(() => {}); return promise; }\n'
  );
}

export function pdfjsPatchPlugin() {
  return {
    name: 'docsluice-pdfjs-prefetch-patch',
    transform(source, id) {
      if (!id.replaceAll('\\', '/').endsWith('/unpdf/dist/pdfjs.mjs')) return null;
      return { code: patchPdfJs(source), map: null };
    },
  };
}
