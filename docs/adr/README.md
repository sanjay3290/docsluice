# Architecture decision records

One file per decision. An ADR wins over the PRD when they disagree.

To change a decision, write a new ADR that supersedes the old one. Do not edit an accepted ADR, except to set its status to "Superseded by NNNN".

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](0001-name.md) | Name: docsluice | Accepted |
| [0002](0002-licence.md) | Licence: MIT | Accepted |
| [0003](0003-clean-room.md) | Clean-room build | Accepted |
| [0004](0004-packaging.md) | One package with lazy subpath exports; CLI bin in core; OCR plugin separate | Accepted |
| [0005](0005-inflate-and-zip.md) | Own zip reader on fflate's pure-JS inflate everywhere | Accepted |
| [0006](0006-image-bytes.md) | Images: references by default, bytes opt-in | Accepted |
| [0007](0007-markdown-tables.md) | Markdown tables: flatten by default, HTML opt-in | Accepted |
| [0008](0008-xml-parser.md) | Own non-validating XML tokenizer, no dependency | Accepted |
| [0009](0009-pdf-engine.md) | PDF engine: unpdf (serverless pdf.js), lazy-loaded | Proposed — confirm in the PDF spike issue |
| [0010](0010-toolchain.md) | Toolchain: TypeScript 6.0, tsdown, Vitest, Node 24 for development | Accepted |
| [0011](0011-dependency-policy.md) | Runtime dependency allow-list | Accepted |
| [0012](0012-fuzz-runner.md) | Fuzzing: Jazzer.js as a dev dependency, one process per target | Accepted |
| [0013](0013-documentation-site.md) | Documentation site: a small markdown-it generator and TypeDoc, not VitePress or Starlight | Accepted |

Template: copy [0000-template.md](0000-template.md).
