const NAME = '[A-Za-z_$][\\w$]*';

/**
 * CMap bounds (#262). A CMap maps at most this many codes through ranges, and only codes below it.
 * pdf.js stores codes as array indexes and copies a CMap into `Array(highest code + 1)`, so a
 * single high code would cost 8 bytes for every lower code.
 */
export const PDF_CMAP_MAX_CODES = 65_536;

/**
 * Approved pdf.js patch sites. Each pattern matches structure, not minified names, and must match
 * exactly once in the engine, so an unpdf upgrade cannot silently drop a patch.
 */
const SITES = [
  {
    // #206: observe unused page-kids prefetch rejections in Catalog.getPageDict.
    name: 'page-kids prefetch',
    pattern: new RegExp(
      `this\\.toplevelPagesDict&&(${NAME}) instanceof (${NAME})&&!(${NAME})\\.has\\(\\1\\)&&\\3\\.put\\(\\1,(${NAME})\\.fetchAsync\\(\\1\\)\\)`,
      'g',
    ),
    replace: (_, kid, ref, cache, xref) =>
      `this.toplevelPagesDict&&${kid} instanceof ${ref}&&!${cache}.has(${kid})&&${cache}.put(${kid},docsluicePdfPrefetch(${xref}.fetchAsync(${kid})))`,
  },
  {
    // #261: observe sibling promises before Catalog.getPageIndex can throw.
    name: 'page-index prefetch',
    pattern: new RegExp(
      `\\.push\\((${NAME})\\.fetchAsync\\((${NAME})\\)\\.then\\((${NAME})=>\\{if\\(!\\(\\3 instanceof (${NAME})\\)\\)throw new (${NAME})\\(\`Kid node must be a dictionary\\.\`\\);if\\(\\3\\.has\\(\`Count\`\\)\\)\\{let (${NAME})=\\3\\.get\\(\`Count\`\\);if\\(Number\\.isInteger\\(\\6\\)&&\\6>=0\\)\\{(${NAME})\\+=\\6;return\\}throw new \\5\\(\`Count must be a \\(positive\\) integer\\.\`\\)\\}\\7\\+\\+\\}\\)\\)`,
      'g',
    ),
    replace: (call) => `.push(docsluicePdfPrefetch(${call.slice('.push('.length, -1)}))`,
  },
  // #262: cap the codes each CMap maps through ranges; extra ranges take pdf.js's existing
  // "ignoring data above MAX_MAP_RANGE" error path, which drops that range and keeps parsing.
  ...['mapCidRange', 'mapBfRange', 'mapBfRangeToArray'].map((method) => ({
    name: `CMap ${method} cap`,
    pattern: new RegExp(
      `${method}\\((${NAME}),(${NAME}),(${NAME})\\)\\{if\\(\\2-\\1>(${NAME})\\)throw Error\\(\`${method} - ignoring data above MAX_MAP_RANGE\\.\`\\)`,
      'g',
    ),
    replace: (_, low, high, value, max) =>
      `${method}(${low},${high},${value}){if(${high}-${low}>${max}||!docsluicePdfCMapReserve(this,${low},${high}))throw Error(\`${method} - ignoring data above MAX_MAP_RANGE.\`)`,
  })),
  {
    // #262: a single code is stored only below the CMap bound.
    name: 'CMap mapOne bound',
    pattern: new RegExp(`mapOne\\((${NAME}),(${NAME})\\)\\{this\\._map\\[\\1\\]=\\2\\}`, 'g'),
    replace: (_, code, value) =>
      `mapOne(${code},${value}){if(!(${code}<${PDF_CMAP_MAX_CODES}))return;this._map[${code}]=${value}}`,
  },
  {
    // #262: the pdfFonts limit. Deny a new font once the document's allowance is used.
    name: 'font load limit',
    pattern: new RegExp(
      `(loadFont\\(${NAME}(?:,${NAME})*(?:,${NAME}=null)*\\)\\{let errorFont=async\\(\\)=>[^;]*;)(.{0,600}?if\\((${NAME})\\.cacheKey&&this\\.fontCache\\.has\\(\\3\\.cacheKey\\)\\)return this\\.fontCache\\.get\\(\\3\\.cacheKey\\);)(?=let\\{promise:)`,
      'gs',
    ),
    replace: (_, head, body) =>
      `${head}${body}if(!docsluicePdfFontAllowed(this.idFactory.getDocId()))return errorFont();`,
  },
];

const HELPERS = `
function docsluicePdfPrefetch(promise) { promise.catch(() => {}); return promise; }
const docsluicePdfCMapCodes = new WeakMap();
function docsluicePdfCMapReserve(cmap, low, high) {
  if (!(high < ${PDF_CMAP_MAX_CODES})) return false;
  const count = Math.max(high - low + 1, 0);
  const used = docsluicePdfCMapCodes.get(cmap) ?? 0;
  if (count > ${PDF_CMAP_MAX_CODES} - used) return false;
  docsluicePdfCMapCodes.set(cmap, used + count);
  return true;
}
const docsluicePdfFontAllowances = new Map();
function docsluicePdfFontAllowed(docId) {
  const allowance = docsluicePdfFontAllowances.get(docId);
  if (allowance === undefined) return true;
  if (allowance.loaded >= allowance.limit) {
    allowance.denied = true;
    return false;
  }
  allowance.loaded += 1;
  return true;
}
/** docsluice: count fonts one loading task loads; the engine denies fonts past \`limit\`. */
export function docsluiceTrackPdfFonts(loadingTaskDocId, limit) {
  const key = 'g_' + loadingTaskDocId;
  const allowance = { limit, loaded: 0, denied: false };
  docsluicePdfFontAllowances.set(key, allowance);
  return {
    get loaded() { return allowance.loaded; },
    get denied() { return allowance.denied; },
    release() { docsluicePdfFontAllowances.delete(key); },
  };
}
`;

export function patchPdfJs(source) {
  let patched = source;
  for (const site of SITES) {
    const found = [...patched.matchAll(site.pattern)].length;
    if (found !== 1)
      throw new Error(`The pdf.js ${site.name} patch must match exactly once; found ${found}.`);
    // A function replacement: a `$` in a minified name must not act as a replacement pattern.
    patched = patched.replace(site.pattern, site.replace);
  }
  const notice = `/*! pdf.js 6.1.200: Copyright Mozilla Foundation. Apache-2.0.
 * unpdf 1.8.1: Copyright (c) 2023-PRESENT Johann Schopplich. MIT.
 * Modified by docsluice: observe page-tree prefetch rejections (#206, #261);
 * cap CMap ranges and count loaded fonts (#262).
 * Full license texts: THIRD_PARTY_NOTICES.md.
 */\n`;
  return notice + patched + HELPERS;
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
