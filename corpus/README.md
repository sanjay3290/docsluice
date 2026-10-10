# Corpus

Real-world files with reviewed expected output. Layout, licence rules and the golden runner: [docs/testing.md](../docs/testing.md#2-golden-tests-qa-2).

Every file needs a `.license` file beside it. Never add private documents or files from any organisation's systems.

Every `.license` file has three lines the tooling reads: `SPDX-License-Identifier:`, `Source:` and `Requirements:`, a comma-separated list of the PRD requirement IDs the file exercises (for example `Requirements: XLS-1, XLS-5`). `npm run docs:support` builds [the support matrix](../docs/formats/support-matrix.md) from these tags and fails on a missing or unknown tag.
