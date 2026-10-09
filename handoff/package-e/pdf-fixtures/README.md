# Original synthetic PDF fixture preparation

Regenerate with `python3 generate.py generated`; run `python3 -m unittest discover -s . -p 'test_*.py' -v` from this directory. Tests require Poppler `pdftotext` as an independent development-time verifier. The generator uses only Python's standard library.

Four benign PDFs provide labels/bookmarks/link metadata, a two-column layout with interleaved content-stream order, a full-page image with no text, and 100 text pages. Each is an original synthetic file with a CC0 sidecar. This is fixture preparation, separate from A #27's real office-suite corpus.

Tests verify regeneration byte identity, all xref/object offsets, per-page text with Poppler, and selected structural markers. Poppler text success does not prove docsluice extraction, page-label/outline/link output, PDF security controls, engine compatibility, or the 3-second PERF-1 target. The image-only sample is a simple full-page synthetic color, not an OCR accuracy sample. No human-rendered reading-order review was performed. Expected source facts in `expected-fixture-content.json` are not public output goldens.

The hostile subdirectory contains inert-by-design action markers, deliberately corrupted xref, and truncation samples. Only byte structure is checked; no hostile document was opened by a viewer and no docsluice hostile runner was available. `manifest.delta.json` is a tentative integration proposal requiring actual outcome assignment, including feature/no-network/no-execution assertions.

Not provided: encrypted PDFs, CJK/RTL/rotated PDFs, headers/footers, forms, annotation goldens, ruled-table accuracy data, cyclic-xref/page-tree attacks, 100,000-page trees, fuzz targets, full cross-runtime checks. The input syntax uses classic PDF objects, streams, pages, Type1 text, number trees and actions from first principles; see the [PDF Association specification index](https://pdfa.org/resource/pdf-specification-archive/) for the primary standards.
