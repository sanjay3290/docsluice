# ZIP child-order integration regression evidence

Prepared 2026-10-09 against `docsluice-package-e-zip-integration` at
`9e343f04cd10a0273c958496f5386d0c40d22809`. This is preparation evidence only;
the red test is deliberately stored outside the runnable package test tree.

Run from `/workspace/package-e-preparation`:

```sh
/workspace/docsluice-package-e-zip-integration/node_modules/.bin/vitest run \
  zip-pipeline-order-regression.test.ts --root /workspace/package-e-preparation
```

Result: **1 test failed**, as expected. The test archive has directory entries
in the first, middle, and last central-directory positions, alongside two
successfully extracted text entries and a child reader failure. Expected order:

```text
directory-first/ (skipped)
first.txt (extracted)
failed.txt (failed)
directory-middle/ (skipped)
second.txt (extracted)
directory-last/ (skipped)
```

Observed order:

```text
directory-first/ (skipped)
directory-middle/ (skipped)
directory-last/ (skipped)
first.txt (extracted)
failed.txt (failed)
second.txt (extracted)
```

The reproduced boundary is between the ZIP reader and shared pipeline. The
reader immediately calls `ctx.out.addChild()` for skipped/unreadable entries in
`packages/docsluice/src/readers/zip/index.ts`; extracted entries are returned
as work from `ctx.extractChild()` and appended later, after `reader.read()` has
completed, in `packages/docsluice/src/core/extract.ts`. This makes a single
central-directory ordered child list impossible with the current two emission
paths when their statuses are interleaved. No shared-core change was made.
Integration lead should decide whether to introduce ordered child slots or
another unified emission API; do not infer ZIP-quine acceptance from this
test. The test uses a synthetic child reader failure and directory entries,
not a recursive ZIP fixture.
