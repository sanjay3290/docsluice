# Package E shared-pipeline regression handoff

This branch is a reproducible handoff for the integration lead. Its tests are
intentionally red against pipeline commit
`a3b45f12429216d72fb3cb3e21955d5947b38c0d` and private reader snapshot
`1928c407eaa5fd2e562553f7d98ba9e4ab472c8a`, integrated at
`9e343f04cd10a0273c958496f5386d0c40d22809`. Do not merge this branch as a
completed reader change. It changes no shared core, registry, exports or CI.

Run from a checkout after `npm ci --ignore-scripts`:

```sh
npm test --workspace packages/docsluice -- \
  test/readers/images/pipeline-regression.test.ts \
  test/readers/zip/pipeline-order-regression.test.ts
```

Expected baseline result: 19 tests, 10 failures. Nine image assertions fail
because the extractor skips registered PNG/JPEG/GIF/TIFF/WebP readers. One
mixed ZIP assertion fails because directory children are added immediately,
while extracted and failed child-work results are added after the reader ends.
This puts directory entries ahead of intervening extracted and failed entries.
The ZIP case places directories first, middle and last; it uses a synthetic
text reader failure and does not establish genuine ZIP-quine acceptance.

`image-pipeline-dispatch.patch` is a proposed shared-core fix: load a registered
reader before applying the fallback for unregistered no-text formats. It keeps
the current empty fallback for an unregistered image and rejects other
unregistered formats. A temporary application passed all 18 image tests; the
shared source was then restored. Registration still belongs to the lead.

Issue #69 also authorizes this addition to `ExtractOptions`:

```ts
/** Include EXIF GPS coordinates. Defaults to false; ignored when metadata is false. */
imageGps?: boolean;
```

The image reader requires an explicit `=== true` GPS opt-in. No default-on
behavior is proposed. Public options remain lead-owned.

ZIP ordering needs a lead-owned unified ordered-child mechanism for both
`out.addChild()` and `extractChild()` output. Preserve enqueue order for
concurrent siblings and the builder's snapshot/privacy guarantees; fixing
only sequential await behavior would leave those contracts unverified.

Fixtures and image readers are included in this branch's dependency history.
All sample bytes are original synthetic inputs; TIFF/JPEG/WebP examples are
metadata snippets. Assertions review their source facts, not rendered-image
validity. The lead should cherry-pick the handoff commit or copy these tests
into its integration branch, implement the shared fixes, and rerun full
verification and CI before closing either issue.
