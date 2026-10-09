> Current implementation addendum: a private VSDX reader, original fixtures and regression tests are now published in draft PR161, implementation commit `7b3e0f9192385672c9bfd6278b605c396ebcfbb6`. This proposed packaging ADR remains unaccepted; public plugin/detection wiring and broad Visio interoperability are not claimed. The historical “not implemented” statements below refer to the research checkpoint.

# ADR proposal: VSDX as an optional format plugin; defer other P2 readers

**Status: Proposed only — not accepted.** No repository ADR was changed. Applies to PRD §8.1 P2/plugin candidates (VSDX, Apple iWork, LaTeX, audio/video metadata), ADRs 0003/0004/0011, and issue #88. This draft does not authorize a dependency, package, or implementation.

## Context and evidence

Microsoft describes VSDX as a ZIP package whose page XML contains shapes and shape text ([MS-VSDX overview](https://learn.microsoft.com/en-us/openspecs/sharepoint_protocols/ms-vsdx/29bd5bbc-db66-46f9-906e-140c5a4e59c8), [Page XML example](https://learn.microsoft.com/en-us/openspecs/sharepoint_protocols/ms-vsdx/dccbb4b5-ca0c-43ef-9379-00c1acb54377)). This makes text-only extraction feasible without rendering. Shared OOXML helpers #28 and versioned plugin registration #41 are prerequisites for the proposed plugin route.

Apple's public iWork document API describes export through iWork apps, not a stable IWA parser specification ([iWork Document Exporting API](https://developer.apple.com/documentation/iworkdocumentexportingapi)). The issue's IWA/Protobuf/Snappy description is not Apple-published normative documentation, so schema compatibility and clean-room evidence remain open. LaTeX's own project publishes extensive kernel and command documentation, but not a general command-stripping/source-to-prose mapping ([LaTeX documentation](https://www.latex-project.org/help/documentation/)). Media metadata spans different container/tag families; for example, ID3 provides an informal tag specification and MPEG documents ISO Base Media File Format as a separate standard ([ID3v2.4 structure](https://id3.org/id3v2.4.0-structure), [MPEG ISOBMFF](https://www.mpeg.org/standards/MPEG-4/12/), [Apple QuickTime atoms](https://developer.apple.com/documentation/quicktime-file-format/atoms)). No single source or corpus establishing a useful cross-media minimum was reviewed for this proposal.

## Decision proposed

1. **VSDX: optional plugin, text-only.** Keep it outside the core reader set initially because the PRD places it in P2/plugin and an isolated plugin lets adopters choose the format. Once #41 and #28 land, the plugin may use shared safe ZIP/relationship/XML helpers. It has no proposed runtime dependency. If maintainers instead want a built-in lazy reader, amend this proposal and assess incremental bundle size against ADR 0004's Office budget.
2. **iWork: defer; plugin candidate only after public-format evidence.** No core parser or dependency until a stable, publicly documented schema and lawful corpus fixtures are available. Do not copy or port unofficial IWA parser code. If public evidence remains insufficient, leave support to an external adapter.
3. **LaTeX: no separate reader in this ADR.** Existing text handling may preserve `.tex` as source text. Do not strip commands, expand macros, resolve `\input`, or execute TeX. A future structured-source plugin needs its own scope and tests; rendering/compilation is out of scope.
4. **Audio/video: defer metadata readers to format-specific plugins.** No generic core media parser. A future proposal must name exact containers/tags (for example, ID3-tagged audio and selected ISO-BMFF/QuickTime boxes), fields, maximum box/tag sizes, and corpus. No codec, media decode, network access, or transcript generation is included.
5. First-party plugin packages are not authorized by this draft. ADR 0004 currently identifies OCR as the separate package; adding maintained VSDX/media/archive packages needs an explicit packaging decision. No runtime dependencies are approved; each requires ADR 0011's size/licence/maintenance/install-script review.

## Minimum VSDX tests after #28 and #41

Use original or clearly licensed tiny fixtures. Golden output should assert deterministic page and shape order, page names, Unicode and line-break preservation in `<Text>`, multiple shapes, grouped/nested shape text, connector text, empty page, empty shape, and shapes without text. Confirm relationship targets are resolved through the package graph; malformed/missing relationships, duplicate IDs, hostile ZIP/XML limits, and traversal-like part names stay bounded and do not cause network or filesystem access. Output should be one page section per drawing page with readable text blocks in source order. Do not emit geometry or claim visual reading order in v1. Masters/style inheritance, rendering, embedded objects, formulas, and relationships that require evaluation remain excluded and should warn or be documented as unsupported.

## Consequences and open items

VSDX can reuse existing package/XML work and add no codec dependency, but its plugin packaging and incremental size are unmeasured. #28 and #41 remain hard blockers. iWork lacks a primary public format specification in the evidence reviewed; media scope and legal corpus evidence remain unassessed. This proposal does not accept an ADR or claim any reader exists.
