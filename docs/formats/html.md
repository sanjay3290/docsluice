# HTML

The HTML reader uses an iterative lenient tokenizer and tree builder. It emits headings, paragraphs, lists, tables with row/column spans and captions, preformatted code, anchor text, and image alt text. Adjacent inline text remains one paragraph. Implied paragraph, list-item, table-row/cell and option endings work through formatting elements. Unknown wrappers preserve their contents. It drops head text, script/style raw text, noscript/template contents, comments and declarations. Content is never executed or fetched.

Character-set priority is BOM, actual meta declaration in the first 1024 bytes, charset in the caller's MIME hint, then the shared encoding detector. Invalid labels produce `ENCODING_GUESSED`. Numeric entities and 253 common named references are supported. Unknown references and references without a semicolon remain literal. The generated common-name table is 1,613 bytes gzipped in this source snapshot; the full WHATWG table is not bundled. The list is the common HTML 4 set plus `apos`; additional WHATWG names are a compatibility gap. Entity output is bounded after decoding, so an exact-fitting sequence is retained.

`runs: true` retains hrefs on paragraph runs. Ordinary anchors do not set `hasExternalLinks`; external image/link/iframe/source resources do. Script tags and `on*` attributes set `hasJavaScript`. Images are placeholders with alt text; CID images can resolve to extracted mail-child paths through the shared helper's explicit CID map.

Every file scan checks the budget. Elements nested deeper than `blockDepth` are flattened: their tags become transparent, their text joins the nearest kept ancestor, and one `DEPTH_LIMIT` warning is added. Parsing continues after the deep region, and hidden containers stay hidden at any depth. Output staging uses the shared character allowance, and table cells use the shared cell allowance. Attributes are capped at 256 per tag, names at 128 characters, and the staged visible tree at 100,000 nodes. The node cap reports `UNREADABLE_PART` and skips later content. This is a parser safety cap; it does not currently set the core truncated statistic. The tokenizer is intentionally smaller than a browser's full HTML parsing algorithm: malformed adoption-agency formatting, CSS visibility/layout, form controls and complex nested tables are approximate.

Table rows follow the output model's grid. A cell starts at the next column not covered by an earlier `rowspan`, and covered positions hold empty cells, so `rows[r][c]` is always grid column `c`. `colspan` is capped at 1,000 and `rowspan` at 65,534, as in the HTML table model. Placeholder cells count toward `cells`.

`extract()` loads this reader lazily for `html` input. It is also available as the `docsluice/html` subpath (`htmlReader`). A page whose `<meta>` declares Windows-1252 decodes with that charset; when its bytes are not valid UTF-8, detection still reports a generic `ENCODING_GUESSED` before the reader sees the declaration.

## Main content (HTM-2)

With `mainContent: true`, the reader keeps only a page's main content. The selection is deterministic, takes linear time over the parsed tree, and lives in its own module (`src/html/main-content.ts`). That module loads only when the option is on, so it is not in the core bundle. The option is ignored for HTML inside email and EPUB.

1. **Chrome is never a candidate.** That covers `nav`, `aside`, `dialog`, `menu`, page-level `header` and `footer`, the ARIA roles `navigation`, `banner`, `contentinfo`, `complementary`, `search` and `dialog`, elements marked `hidden` or `aria-hidden="true"`, and elements whose class or id contains a chrome word. Class and id are split into words, so `unavailable` does not match `nav`. The chrome words are: `nav`, `navbar`, `navigation`, `menu`, `breadcrumb(s)`, `sidebar`, `footer`, `masthead`, `comment(s)`, `ad(s)`, `advert`, `advertisement`, `sponsor(ed)`, `promo`, `related`, `share`, `social`, `cookie(s)`, `consent`, `newsletter`, `subscribe`, `popup`, `modal`.
2. **The first `main`** (or `role="main"`) wins.
3. **Otherwise the `article` with the most text** wins; ties go to the first.
4. **Otherwise containers are scored** (`div`, `section`, `td`, `body`). Each paragraph-like block (`p`, `pre`, `blockquote`, `li`, `td`, `dd`) needs at least 25 characters, with no more than half its text in links. Its unlinked text counts fully for its parent and half for its grandparent. A content word in the container's class or id (`content`, `article`, `main`, `post`, `entry`, `story`, `prose`, `body`) adds a quarter. The highest score wins; ties go to the first in document order. A page with no qualifying block is kept whole.

Inside the chosen element, chrome is still left out: an in-page `nav`, a comments section, share buttons. An article's own `header` and `footer` stay, because they hold its title and byline.

`corpus/html/main-content/` has ten written pages: a blog post, a news article, a docs page with a sidebar, div soup, a link farm, a recipe with ads, a listing of articles, a table layout, hidden and dialog content, and a page with nothing to score. Each page has a reviewed `.main-content.expected.md` golden, and `test/readers/html/main-content.test.ts` checks text that must stay and text that must go. The HTML fuzz target runs every input with and without the option.

Specification references: [WHATWG parsing](https://html.spec.whatwg.org/multipage/parsing.html), [named references](https://html.spec.whatwg.org/entities.json).
