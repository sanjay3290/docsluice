# Image pipeline integration evidence for issue #69

## Reproduction

Standalone regression: `image-pipeline-regression.test.ts` (kept outside the repository's committed test suite). It exercises the public `detect()` and `createExtractor()` pipeline with a private `ReaderRegistry` populated from the existing image readers. It covers PNG, JPEG, GIF, both-endian TIFF, and VP8/VP8L/VP8X WebP fixtures; metadata/date; GPS absent by default and enabled explicitly; `metadata: false`; and an unregistered empty-format fallback.

From `/workspace/docsluice-package-e-images-integration/packages/docsluice`, temporarily copy the external test into the normal Vitest include and run:

```sh
cp /workspace/package-e-preparation/image-pipeline-regression.test.ts test/image-pipeline-regression.test.ts
../../node_modules/.bin/vitest run test/image-pipeline-regression.test.ts
rm test/image-pipeline-regression.test.ts
```

The preserved red output is `image-pipeline-red.log`; it reports 18 tests with 9 failures. All eight registered image cases returned `blocks: []`, and the metadata/GPS pipeline case had no capture date. Signature detection and the unregistered empty fallback passed. This demonstrates `core/extract.ts` skips all registered no-text readers because the `EMPTY_FORMATS` check happens before `registry.load()`.

For green proof only, I applied the exact temporary shared-core change in `image-pipeline-dispatch.patch`, reran the same regression, then restored `packages/docsluice/src/core/extract.ts` to the original branch content. `image-pipeline-green.log` records 18/18 passing, including no-reader fallback. No shared-core patch remains in the worktree.

## Minimal shared-core patch proposal

Use the saved patch file. Its dispatch order is:

1. Ask the registry for a reader for the resolved format.
2. If registered, load and invoke it, even when the format is in `EMPTY_FORMATS`.
3. If no reader exists, preserve today's empty no-text fallback for `EMPTY_FORMATS`; continue throwing `UnsupportedFormatError` for other unregistered formats.

This is intentionally limited to dispatch. Built-in image registrations remain a separate integration decision.

## `imageGps` public option TSDoc proposal

Add to `ExtractOptions` in `packages/docsluice/src/core/options.ts`:

```ts
  /** Include GPS coordinates stored in EXIF metadata. Defaults to false because coordinates can reveal a person's location. Ignored when `metadata` is false. */
  imageGps?: boolean;
```

`ResolvedOptions` already extends the option shape and needs no special default behavior because the reader's GPS gate is an explicit `=== true` check. The issue explicitly authorizes this option; this proposal records its scope and privacy semantics without editing shared options here.

## Limitation

On the current unpatched integration branch, actual `extract()` calls skip registered image readers and return no image blocks or EXIF metadata. Direct reader unit tests pass, but they do not establish pipeline integration. The temporary green run proves the proposed dispatch fix against the regression; it does not claim that the core fix or all image registrations have been merged.
