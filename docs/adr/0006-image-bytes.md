# 0006. Images: references by default, bytes opt-in

- Status: Accepted
- Date: 2026-10-09
- Requirement IDs: DOC-8, NST-5, PRD Q6

## Context

LLM apps often want image bytes for a vision model. Holding every image in memory costs a lot on large files.

## Decision

- An `image` block carries `ref`: the path of a child document that holds the image (for example `word/media/image1.png`).
- Each image appears in `doc.children` with status `listed` and its size and MIME type.
- With `childBytes: true`, the child holds `bytes` as a `Uint8Array`. The bytes count against the budget.

## Consequences

- Callers who want vision input set one option and follow `ref` to `children`.
