# Format status

This page is an implementation snapshot, not the PRD roadmap. At this foundation commit, only legacy Word `.doc` is registered for extraction. Other formats may be recognized by `detect()` or parsed by low-level ZIP, OLE, and XML utilities; those are not format readers.

| Format or group | Current behavior |
|---|---|
| Legacy Word `.doc` | Registered extraction reader; see [details](/formats/doc). |
| DOCX, XLSX, PPTX | Container kind detection only; no document readers registered. See [DOCX](/formats/docx), [XLSX](/formats/xlsx), and [PPTX](/formats/pptx). |
| PDF | Signature detection only; no PDF reader registered. See [PDF status](/formats/pdf). |
| ZIP | Archive indexing utility only; no ZIP child extraction reader. See [ZIP status](/formats/zip). |
| TXT, Markdown, CSV, TSV, JSON, XML, HTML | Text detection only; no text reader registered. See [TXT](/formats/txt), [Markdown](/formats/markdown), [CSV](/formats/csv), [TSV](/formats/tsv), [JSON](/formats/json), [XML](/formats/xml), and [HTML](/formats/html). |
| Other formats | Detection or low-level utilities only where implemented; no content readers registered. |

The corpus-derived support matrix requested by issue #65 is pending integration. This page will link to that generated inventory when it is available. The CLI examples requested by issue #63 are also pending integration.
