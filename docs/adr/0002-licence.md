# 0002. Licence: MIT

- Status: Accepted
- Date: 2026-10-09
- Requirement IDs: PRD Q3

## Context

The PRD recommended Apache-2.0 for its patent grant. The owner chose MIT: it is shorter and the most common licence on npm.

## Decision

The repository and every package use the MIT licence.

## Consequences

- pdf.js (via unpdf) is Apache-2.0. MIT code may depend on Apache-2.0 code. Keep its licence notice in the bundle and in `THIRD_PARTY_NOTICES.md` when the PDF reader ships.
- Corpus files keep their own licences, recorded beside each file (QA-1).
