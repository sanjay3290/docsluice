# OpenDocument helpers

The internal `src/odf/` helpers prepare metadata, style inheritance and manifest data for the ODT, ODS and ODP readers. They use the shared non-validating XML tree parser and accept its `XmlContext`, so parser warnings, strict mode, cancellation and budgets remain shared with the surrounding extraction.

`parseOdfMetadata(input, ctx, options?)` returns the existing `Metadata` model. It accepts an `office:document-meta` package part or flat `office:document` root and reads only direct recognized fields beneath a direct `office:meta` child; extension descendants and metadata-looking values elsewhere in the document are ignored. It maps Dublin Core title, language, creator and date fields plus ODF initial creator, creation date, page count and user-defined properties. Set `metadata: false` to omit authors and custom properties while retaining non-personal fields. Dates and page counts are validated before inclusion.

`parseOdfStyles(input, ctx)` accepts ODF `office:document-styles`, `office:document-content` or flat `office:document` roots, and reads direct `style:style` children of direct `office:styles` or `office:automatic-styles` containers. It returns a `Map` keyed by style name. `resolveOdfStyle(styles, name, ctx)` follows parent styles iteratively and returns nearest defined family, parent name and outline level. Missing parents, cycles and over-depth chains produce structural warnings. Style names remain Map keys, including names such as `__proto__`.

`parseOdfManifest(input, ctx)` accepts a `manifest:manifest` root and direct `manifest:file-entry` children, then returns safe internal path/media-type pairs and a `hasEncryptedEntries` indication. Manifest paths are package-relative literal ZIP entry keys: they are preserved exactly as written and must never be URI-decoded before archive lookup. Percent-encoded slash, backslash and dot bytes are rejected to avoid downstream path confusion; other valid percent sequences remain literal. The helper never reads archive entries, decrypts content or follows a path. Absolute, traversal, URL-like and malformed paths are excluded with a structural warning. The root `/` package entry is recognized and omitted from part mappings.

The ODT ([odt.md](odt.md)) and ODS ([ods.md](ods.md)) readers use these helpers. The ODP reader is not implemented yet.

`packages/docsluice/fuzz/odf.fuzz.ts` runs arbitrary bytes through each helper parser. It is registered as the `odf` target of `scripts/fuzz-run.mjs`.
