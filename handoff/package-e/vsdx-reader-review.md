# Independent VSDX reader review

Date: 2026-10-09
Scope: read-only review of the private VSDX reader and tests in /workspace/docsluice-package-e-vsdx, using the open issue snapshot in /workspace/package-e-preparation/current-issues.json. No source edits made.

## Result

No confirmed VSDX-owned security blocker found in the latest stable source. The earlier root findings are reflected in the current reader/tests: text and page labels are preflighted against output limits; inline text recognizes only the core Visio cp/pp/tp/fld children and skips foreign namespace content; page references with multiple Rel nodes or multiple relationship-qualified IDs are rejected; IDs are normalized before duplicate detection; resource TRUNCATED warnings stop further page work while child-only DEPTH_LIMIT does not; shape traversal is iterative and preserves sibling/nested source order; section closing is protected with finally. Warnings are static and relationship targets are not inserted into them.

## Findings

### P2 — Microsoft source discrepancy for low shape IDs; record the chosen behavior

The current canonicalShapeId function rejects IDs below 4 at packages/docsluice/src/readers/vsdx/index.ts:190. The normative Microsoft ShapeSheet_Type page says ID is an unsigned, unique one-based index, MUST be at least 4, and unique within its containing Shapes_Type: https://learn.microsoft.com/en-us/openspecs/sharepoint_protocols/ms-vsdx/5d6be8d6-1cab-4722-ba32-d73febc4e51d. However, Microsoft's Page XML sample uses Shape ID="1" and describes that as a shape: https://learn.microsoft.com/en-us/openspecs/sharepoint_protocols/ms-vsdx/dccbb4b5-ca0c-43ef-9379-00c1acb54377. The normative type supports the implementation's >=4 guard, but the sample conflicts with it. The current synthetic fixture starts at ID 4, so it does not exercise the disagreement. Document that the reader follows the normative type and consider a focused test for the selected behavior; don't silently treat the sample and type rules as consistent.

### P2 — Metadata strings are bounded by input/part budgets, not the text output counter

The VSDX reader requests package properties at packages/docsluice/src/readers/vsdx/index.ts:331-336. Shared readProperties scalarText collects and joins property text at packages/docsluice/src/ooxml/props.ts:52-64, while DocBuilder.setMetadata clones it without adding output characters at packages/docsluice/src/core/builder.ts:483-493. Thus outputChars tests bound page labels and text blocks, but do not bound a huge title/custom-property string. Input/uncompressed-byte limits still bound source allocation. This may be intentional if outputChars is defined as text-block characters only; confirm the contract with the #28/shared-helper owner and add a regression test if metadata must share the same character cap. This is outside VSDX-owned code and not independently treated as a blocker.

### P3 — Targeted test evidence for connectors and external page relationships could be stronger

The main pipeline test at packages/docsluice/test/readers/vsdx/vsdx.test.ts:71-120 verifies declared page order, grouped shape order and Unicode text. The docs say connector-shape Text is included, but no fixture assertion specifically covers a connector shape with Text/Connects. The source does not interpret Connects or follow a page relationship marked External; external relationship scanning is separately covered at test lines 122-136, but a direct external-page-target case would make the no-follow boundary clearer. Current code and docs are consistent; these are coverage improvements, not observed unsafe behavior.

## Checks performed

- Focused VSDX suite: 19 tests passed.
- Package TypeScript typecheck passed.
- ESLint and Prettier checks passed for the VSDX source, test, fuzz target and format doc.
- Code-path review found no network API or external relationship dereference in the VSDX reader. Root/document/pages/page target resolution goes through the internal OOXML relationship helpers; external relationships are skipped for page navigation and only surfaced as a boolean feature.
- Corpus fixtures are synthetic CC0 source-structure samples; docs/formats/vsdx.md correctly says they have not been opened/rendered by Visio. No native Visio/rendering/plugin-registration acceptance is claimed.

## Remaining integration blockers

Issue #88 remains a private preparation: #41 plugin API and #28 shared OOXML helpers are blockers. The integration manifest keeps VSDX out of the default registry, correctly uses forced format in tests, and records that public MIME detection is not implemented. Inline expected blocks are manually authored from synthetic source facts, not golden results from genuine Visio files. The current work therefore should not be reported as completing issue #88 or as proving broad VSDX interoperability.
