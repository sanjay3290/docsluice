# Assess PST as an optional plugin

- Status: Proposed; requires integration lead review and number assignment
- Date: 2026-10-09
- Requirement IDs: section 8.1 (Email P2), SEC-6, SEC-8, SEC-9, SEC-12, SEC-14, NST-1
- Issue: #87
- Basis: live issue read; frozen archive not available in this executor

## Context

MBOX is a sequence of EML messages. PST is a distinct binary message store with
folder, message and attachment hierarchies, described by [MS-PST](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-pst/141923d5-15ab-4ef1-a524-6dce75aae546).
The specification separates a Node Database layer, a Lists, Tables and
Properties layer, and a Messaging layer ([logical architecture](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-pst/de4157d3-fc53-4aec-81be-d1659c8a2302)).

From that layering, we infer that a PST reader requires substantial storage
validation beyond the EML and MSG adapters. A CFB reader is not a substitute for
PST storage parsing. This package has not implemented or benchmarked PST and has
not assessed third-party plugin dependencies. ADR 0011 permits only the already
accepted core runtime dependencies; no dependency approval is implied here.

## Proposed decision

Deliver MBOX through EML child extraction under the existing shared budget.
Assess PST separately as an optional plugin.
Do not add a PST implementation, runtime dependency, or parser shortcut to core
as part of Package B. Preserve the honest unsupported-format behavior
until a reviewed implementation is integrated.

## Required assessment before a plugin decision

- Clean-room bounded storage parser design for supported PST variants, with
  explicit iterative graph traversal, cycle checks, range validation and limits.
- Mapping of folders, messages, recipients and attachments to the approved child
  document contract; total work must use the same parent budget.
- Privacy behavior for sender/recipient/contact fields under `metadata: false`.
- Authored/licensed PST samples and hostile truncated, cyclic and oversized
  block/reference cases; compare decoded messages with reviewed EML equivalents.
- Runtime compatibility, memory bounds, dependency licence/maintenance/install
  scripts and exact version approval if any dependency is proposed.

## Consequences

MBOX parsing can progress independently. PST remains an explicit
unimplemented format while its parser/plugin design is assessed. No user-visible
option or default changes here. Acceptance of this ADR, corpus verification,
plugin support and #87 public integration remain open. The current detector must
route `message/rfc822` children through EML before MBOX can apply its header and
privacy behavior; the isolated parser already forwards this MIME hint.
