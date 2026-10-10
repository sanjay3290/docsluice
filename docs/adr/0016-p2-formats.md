# 0016. P2 formats: VSDX in core; LaTeX and media metadata later; iWork only as a plugin

- Status: Accepted
- Date: 2026-10-10
- Requirement IDs: PRD section 8.1 (P2 and plugin column), EXT-4, ADR 0003 (clean-room), ADR 0011 (dependencies)

## Context

Issue #88 asks for each P2 format to be assessed, the core-or-plugin choice recorded, and the cheapest valuable ones implemented, with VSDX at least.

| Format | What it is | Public specification | Cost |
|--------|------------|----------------------|------|
| Visio VSDX | An OPC (ZIP + XML) package, like the other OOXML formats | [MS-VSDX] | Small: it reuses the ZIP, XML and OOXML helpers. Detection already classified it. |
| LaTeX | Plain text with commands | The LaTeX grammar is informal; macros are Turing-complete | Small for "commands stripped", but it needs careful detection to avoid misreading plain text. |
| Audio/video metadata | ID3, MP4 boxes, FLAC, Ogg, RIFF | Public (ISO/IEC 14496-12, ID3v2, Xiph) | Medium: several walkers, each with size-lie and loop hazards. Detection already reports `audio` and `video` with empty documents. |
| Apple iWork | A ZIP of IWA files: Snappy-framed protobuf | Snappy is public; the protobuf message schemas are not | Large, and the schemas come only from reverse engineering. |

## Decision

- **VSDX is a core reader**, loaded lazily (`docsluice/vsdx`, format `vsdx`). It gives one `page` section per Visio page, in the order of the pages part, with shape text in XML order (grouped shapes included). Formulas are never evaluated and external relationships never followed. It ships now (#88).
- **LaTeX will be a core text reader** with a hand-written scanner, in its own issue ([#247](https://github.com/sanjay3290/docsluice/issues/247)). It is not part of #88, because detection needs its own tests against plain text.
- **Audio and video metadata will extend the core detection results** in their own issue ([#248](https://github.com/sanjay3290/docsluice/issues/248)): container metadata only, never decoding. Until then they remain empty documents.
- **iWork will not be in the core.** An opt-in plugin is possible only if it can be written from public material ([#249](https://github.com/sanjay3290/docsluice/issues/249)).
- No new runtime dependency for any of them.

## Consequences

- VSDX costs one more lazily loaded reader (Office budget, 40 KB).
- Its corpus is synthetic, because no Visio-made files can be committed. LibreOffice Draw imports the main corpus file with the same text, which is the interoperability check.
- Three follow-up issues carry the rest of #88, labelled `discovered`.
