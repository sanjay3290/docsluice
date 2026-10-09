---
schema: docsluice-quality-truth-v1
source: corpus/doc/doc-legacy.doc
sourceSha256: 5dc5a5f5a64145dd1621d93b32758a939d5853510e0aa18d471bf336dab7f59b
format: doc
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
