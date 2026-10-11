export function patchPdfJs(source) {
  const site =
    /this\.toplevelPagesDict&&([A-Za-z_$][\w$]*) instanceof ([A-Za-z_$][\w$]*)&&!([A-Za-z_$][\w$]*)\.has\(\1\)&&\3\.put\(\1,([A-Za-z_$][\w$]*)\.fetchAsync\(\1\)\)/g;
  const matches = [...source.matchAll(site)];
  if (matches.length !== 1)
    throw new Error(`The pdf.js page-kids prefetch patch must match exactly once; found ${matches.length}.`);
  const match = matches[0];
  const [original, kid, ref, cache, xref] = match;
  const replacement = `this.toplevelPagesDict&&${kid} instanceof ${ref}&&!${cache}.has(${kid})&&${cache}.put(${kid},docsluicePdfPageKidsPrefetch(${xref}.fetchAsync(${kid})))`;
  const notice = `/*! pdf.js 6.1.200: Copyright Mozilla Foundation. Apache-2.0.
 * unpdf 1.8.1: Copyright (c) 2023-PRESENT Johann Schopplich. MIT.
 * Modified by docsluice: observe page-kids prefetch rejections (#206).
 * Full license texts: THIRD_PARTY_NOTICES.md.
 */\n`;
  return (
    notice +
    source.slice(0, match.index) +
    replacement +
    source.slice(match.index + original.length) +
    '\nfunction docsluicePdfPageKidsPrefetch(promise) { promise.catch(() => {}); return promise; }\n'
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
