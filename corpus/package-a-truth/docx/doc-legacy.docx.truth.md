---
schema: docsluice-quality-truth-v1
source: corpus/doc/doc-legacy.docx
sourceSha256: 1a21eccb3c2d2c6840570a1f8231a90ae5147edde954c73b72be6c5e2272cbbb
format: docx
reviewStatus: pending
---
## Text blocks

```json
[
  "Legacy Word fixture",
  "Paragraph with café, €12, and a visible field result: July 4, 2026.",
  "Second heading",
  "Final paragraph for text recall."
]
```
## Tables

```json
[
  {
    "index": 0,
    "cells": [
      { "row": 0, "column": 0, "text": "Item" },
      { "row": 0, "column": 1, "text": "Count" },
      { "row": 1, "column": 0, "text": "Paper" },
      { "row": 1, "column": 1, "text": "3" }
    ]
  }
]
```
## Reading order

```json
[
  { "kind": "text", "index": 0 },
  { "kind": "text", "index": 1 },
  { "kind": "text", "index": 2 },
  { "kind": "cell", "table": 0, "row": 0, "column": 0 },
  { "kind": "cell", "table": 0, "row": 0, "column": 1 },
  { "kind": "cell", "table": 0, "row": 1, "column": 0 },
  { "kind": "cell", "table": 0, "row": 1, "column": 1 },
  { "kind": "text", "index": 3 }
]
```
