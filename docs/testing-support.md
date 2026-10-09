# Support matrix generation

`docs/formats/support-matrix.md` is generated from P0 requirement rows in `docs/prd.md` and the `Requirements:` tags beside corpus files.

Run the generator from the repository root:

```sh
node scripts/docs-support.mjs
node scripts/docs-support.mjs --check
node --test scripts/test/docs-support.test.mjs
```

The generator fails when a corpus fixture lacks its `.license` sidecar, a sidecar lacks a nonempty `Requirements:` field or has malformed/unknown tags, or the corpus contains a symlink. It ignores `.gitkeep` and `.gitattributes` as corpus metadata, after checking that neither is a symlink. It sorts requirements and paths before writing. CI runs the focused tests and `--check`; it reports committed-page drift without rewriting the file.

`Requirements:` tags record the fixture author's intent. They do not establish that a parser supports the requirement. The matrix reports the tagged licensed fixture inventory and JSON/Markdown golden-file presence separately. Presence does not establish that an expected output is reviewed, that a golden test passes, or that the requirement is satisfied. The generator has no reviewed-status source and makes no support assertion.

Six existing licensed real-tool corpus entries now carry `Requirements: QA-1` only: the two ZIP examples and four OLE examples. This records corpus provenance coverage; it does not assert support for ZIP or legacy Office format behavior.

The full `npm run docs:support` alias requires adding a root package script during lead integration; this preparation intentionally leaves package manifests and the lockfile untouched. Per-format behavior pages are owned by the corresponding reader work and are not generated or stubbed here.
