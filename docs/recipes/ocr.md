# OCR

docsluice does not run OCR. It gives you what needs it: `childBytes: true` keeps the bytes of embedded pictures on `doc.children`, image blocks point at them with `ref`, and `doc.stats.needsOcr` marks scanned pages with no text layer.

<!-- include: examples/ocr.mjs -->
