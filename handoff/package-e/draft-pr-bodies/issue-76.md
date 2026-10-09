# Draft only: plugin: OCR interface and @docsluice/ocr-tesseract (EXT-5)

Issue: https://github.com/sanjay3290/docsluice/issues/76

This package contains preliminary research and original synthetic fixtures only. Reader implementation and public integration are pending. Working branch pushes and draft PRs are now authorized, but the exact parent-provided remote foundation ref is pending. These criteria are copied from the current GitHub snapshot and must be reconciled with the unavailable frozen archive before implementation.

- [ ] Scanned corpus PDF gives text through the plugin in Node.
- [ ] Core bundle size unchanged by the OCR interface (size check).
- [ ] Docs page with both adapters.
- [ ] `npm run verify` passes and CI is green

## Decisions and validation limits

- Original checkout is unchanged at d74175e18892af0bd125c03bb4aabf30d0ce7e15.
- Requested foundation 10ae4985a425842f965bccbb9c86a7e6018c5412 was not materialized or validated.
- Supported Library materialization and one bounded retry returned download failed; no baseline/archive local files exist.
- Synthetic fixture checks validate byte structure and regeneration only, with Poppler reading benign PDF text.
- No docsluice goldens, hostile-runner acceptance, fuzz registration, coverage, runtime matrix, or performance criterion is verified.
- Public registration, exports, core/options and shared manifest changes remain integration-lead owned.

Next step: obtain authoritative frozen archive and verified foundation/#10; for #44 obtain A #23; reconcile this draft before issue implementation; use the parent-provided exact base before branch publication.
