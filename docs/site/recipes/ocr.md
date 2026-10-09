# OCR routing

The [tested routing helper](https://github.com/sanjay3290/docsluice/blob/fix/package-a-docs-site/packages/docsluice/examples/site/ocr.ts) returns an OCR action only when `document.stats.needsOcr` is true. It does not invoke an OCR service.

This foundation has no PDF reader, so the routing test uses a synthetic public `DocsluiceDocument` carrying `needsOcr: true`. Once PDF extraction is integrated, call this route on the actual result and send the original bytes to an explicitly selected OCR provider. Keep that provider and any network transfer under application control.
