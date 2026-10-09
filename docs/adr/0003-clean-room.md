# 0003. Clean-room build

- Status: Accepted
- Date: 2026-10-09
- Requirement IDs: R6, PRD Q1

## Context

docsluice is an independent open-source project. Code copied from elsewhere carries someone else's licence and ownership.

## Decision

docsluice is written clean-room:

- Never copy, paste or port code from any employer, client or other third-party codebase.
- Never put adopter-specific logic in docsluice. Adopters use docsluice through a thin adapter that lives in their own code.
- Implement from public specifications (ECMA-376 / OOXML, ISO 32000 / PDF, [MS-CFB], [MS-XLS], [MS-DOC], RFC 5322 / 2045-2049 / 2047, ODF 1.3, EPUB 3, PKWARE APPNOTE) and from first principles.
- Open-source libraries may be studied for behaviour, but their code is not copied unless its licence allows it and the source is credited.
- Never put private documents or files from any organisation's systems in the corpus.

## Consequences

- Adopter acceptance tests (PRD section 22) run in the adopter's code base, not here.
