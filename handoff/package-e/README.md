# Package E reviewable handoff

This checkpoint covers #39, #44–50, #61, #69, #76, #82, #86 and #88. It contains original fixture generators/assets, research probes, reviews, test evidence and exact implementation references. It does not claim all fourteen issues complete. [handoff-refs.json](handoff-refs.json) lists source commits; the coordinator owns merging, issue closure, shared APIs, registry/exports, dependency files and global corpus/hostile/fuzz integration.

Foundation `10ae4985a425842f965bccbb9c86a7e6018c5412` was verified from the parent-provided published branch in an isolated clone. The original checkout remains clean at `d74175e18892af0bd125c03bb4aabf30d0ce7e15`. All three Library inputs failed supported materialization and one bounded local retry with `library file transfer failed: download failed`. The parent authorized current GitHub requirements as a fallback. The readable assignment was read, but the frozen archive remains unavailable; [local-state.json](local-state.json) preserves that record.

## Implemented and reviewable

| Issue | Scope                                                           | Draft PR                                                |
| ----- | --------------------------------------------------------------- | ------------------------------------------------------- |
| #39   | ZIP reader with lazy children and budget/hostile checks         | [104](https://github.com/sanjay3290/docsluice/pull/104) |
| #61   | GZIP member/CRC handling and bounded TAR/PAX/GNU traversal      | [106](https://github.com/sanjay3290/docsluice/pull/106) |
| #69   | PNG/JPEG/GIF/WebP/TIFF dimensions and bounded EXIF/GPS handling | [105](https://github.com/sanjay3290/docsluice/pull/105) |
| #46   | Private positioned-text layout helper                           | [137](https://github.com/sanjay3290/docsluice/pull/137) |
| #48   | Private repeated header/footer helper                           | [150](https://github.com/sanjay3290/docsluice/pull/150) |
| #82   | Private ruled/aligned table candidates with internal confidence | [159](https://github.com/sanjay3290/docsluice/pull/159) |
| #88   | Private VSDX page/grouped/connector text reader                 | [161](https://github.com/sanjay3290/docsluice/pull/161) |

Every draft states its limits. The PDF helpers are not a PDF reader. A separate private reader candidate is in progress, with no production dependency/registry changes. VSDX is not registered; its synthetic packages have not been opened in Visio. Table confidence is uncalibrated; real-PDF cell accuracy, caption emission and corpus goldens are pending.

Separate test branches add ten ZIP and thirteen GZIP/TAR real injected-pipeline cases. They use minimal text/routing observers rather than claiming genuine CSV/HTML reader goldens. The published regression handoff reproduced ZIP mixed-child order and image dispatch failures against #10. Consumed lead `8df90af609f9a92f08f03d052ab953e26b3a3b36` passes all nineteen cases; `handoff/package-e-core-regression-check` includes the typed-context adaptations and fresh full verification. The exact heads/logs are indexed.

## PDF evidence and preparation

[pdf/spike/spike-report.md](pdf/spike/spike-report.md) records exact unpdf 1.7.0 and matching PDF.js 5.6.205 experiments: Node 20/22/24, Bun, canonical cached-only Deno npm imports, Chromium with CSP, and local workerd with an explicit denying outbound service and no Node compatibility/Buffer global. Successful runs observed zero instrumented network/worker/eval calls and no action-marker execution. The independent [runtime review](pdf/spike/runtime-review.md) includes fresh reruns and corrected configuration evidence. Guard timing/API coverage and OS isolation limits are explicit. This does not prove all code paths safe or complete the hosted #23 matrix. ADR 0009 remains Proposed; production subpath/lazy-load size, bundle license/NOTICE and missing asset/action/hostile/corpus checks remain open.

The real-engine ten-page layout probe preserves independently authored source facts. Its initial result was 7/10 fully ordered pages, with all phrases present. Column and rotation regressions led to helper commit `55a60269d5b4a5c0e53e3e96b6dcbbf72338c805`: 8/10 pages now match authored phrase order, with all phrases present. Pages 9 and 10 remain column-wise tables and are retained as explicit integration regressions. [layout-delta-final-review.md](pdf/spike/layout-delta-final-review.md) records independent review.

The advanced probe covers owner/user encryption, forms, annotations, damaged xrefs/truncation and attachments. It identifies the need to convert PDF.js's ordinary attachment object immediately into budgeted arrays, preserving duplicate filenames and an own `__proto__` entry. This is API/fixture evidence, not public error mapping, annotation emission, child extraction or reader acceptance.

There are 45 original binary fixtures with CC0 sidecars: 15 archive, 11 image/metadata samples, 13 PDF and six VSDX. Fresh structural verification passes 31 tests across seven suites. Metadata snippets are distinguished from complete images. No genuine ZIP quine or real application corpus is claimed; encrypted fixture bytes use randomized salts.

`ocr/` and `p2/` contain proposed decisions/designs for OCR, RAR/7z and remaining P2 formats. Tesseract's inspected postinstall hook conflicts with repository policy and needs a dependency decision. Encoded 7z header decoding and RAR source/license feasibility remain unproved; no listing plugin is implemented.

## Reproduction and packaging

Logs retain failed/red commands as well as passing reruns. Use exact-head references and named final logs, not historical counts. `issue-inventory.json` separates implementation, integration and acceptance. `file-inventory.json` records sizes/hashes, excluding itself. Earlier Library checkpoints `libfile_f67a9bba3bec81918fa16e3c3caab02d` and `libfile_0c6056acbf6c8191bcae5982c1e72894` are immutable historical snapshots; they lack current helpers/runtime evidence.

Generated third-party bundles, runtime binaries, node_modules, caches and Git internals are excluded. Commands regenerate tools/bundles under `/tmp`. Executor-specific absolute paths in recorded commands/imports must be adjusted to the receiving checkout/tool locations; another executor's paths are not shared. Standalone preparation Git history is for inspection and must not be cherry-picked as repository source. Sanjay's verified identity is used without AI co-author lines. Working branches and draft PRs are authorized; merges, closure and deployments remain coordinator-only.
