# OCR adapter design proposal (#76)

**Status: research proposal only; no dependency approval, core API change, runtime validation, or engine acceptance.** Prepared 2026-10-09 from the current #76 requirement snapshot. The frozen archive is unavailable, and #76 remains blocked on #45, #41, and #74. ADR 0004 and ADR 0011 are accepted in the present scaffold, but ADR 0011 only allow-lists `fflate` and `unpdf` for the `docsluice` core package; it does not authorize Tesseract or an exact pin.

## Proposed public/core contract

Keep OCR out of `docsluice` and expose it only as an optional provider hook after the blocked core/plugin work lands:

```ts
export interface OcrImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface OcrOptions {
  language?: string;
  signal?: AbortSignal;
}

export interface OcrBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number; // 0..1
}

export interface OcrResult {
  text: string;
  confidence: number; // 0..1
  boxes?: OcrBox[];
}

export type OcrProvider =
  (image: OcrImage, options: OcrOptions) => Promise<OcrResult>;
```

The `OcrProvider` shape matches #76's current requested image bytes, MIME type, optional language/signal, text, confidence and boxes. The concrete `OcrBox` fields above are a proposal because the issue leaves `boxes` unspecified; approve that shape with the core API owner before exposing it. Map Tesseract's page confidence from percent to `clamp(value / 100, 0, 1)`. If boxes are requested, ask for `blocks` output and map each recognized word's `bbox` (`x0`, `y0`, `x1`, `y1`) to top-left pixel coordinates (`x0`, `y0`, `x1-x0`, `y1-y0`); map word confidence to 0–1. Tesseract's type declarations expose page/word confidence and these bounding boxes, and its documented default output is text only, so block output must be explicitly enabled. [Tesseract API/types](https://github.com/naptha/tesseract.js/blob/master/docs/api.md), [official type declarations](https://github.com/naptha/tesseract.js/blob/master/src/index.d.ts)

The core should call the provider only when OCR is requested for an image or an eligible scanned page. For PDFs, #76 specifies using the largest embedded image when it covers most of the page; it does not add a renderer. Vector-only pages therefore remain unsupported by this adapter and need a renderer plugin. Insert nonempty OCR text as paragraph text at the source image/page location. Empty recognized text is a valid result, not an exception. Surface low confidence via a warning while keeping the numeric result; the low-confidence threshold is still an API decision (0.6 is a testable starting proposal, not an accepted constant).

## First-party adapter and worker lifecycle

Consistent with accepted ADR 0004, create a separate optional `@docsluice/ocr-tesseract` package; do not add Tesseract or model data to core dependencies or core bundles. Export a factory such as `createTesseractOcrProvider({ languageDataPath, language?, maxJobs? })` that returns the provider plus `dispose(): Promise<void>`. Dynamic-import Tesseract on first provider call, create one worker lazily, serialize recognition calls through a promise queue, and reuse it for sequential images. Reinitialize when the selected language changes; otherwise create separate provider instances per language. Dispose explicitly and recycle after a conservative bounded number of jobs (for example 500), because the upstream worker guidance warns that WebAssembly memory grows and dictionaries accumulate, and gives 500 jobs as a reset example. [Workers vs schedulers](https://github.com/naptha/tesseract.js/blob/master/docs/workers_vs_schedulers.md)

The Tesseract Node `ImageLike` declaration includes `Buffer` but not `Uint8Array`; the Node-only adapter should copy/wrap bytes using `Buffer.from(image.bytes)`, leaving the core contract web-standard. It should not accept a URL, file path, data URL, or other caller-controlled source as input. Tesseract's Node loader fetches strings that look like URLs and reads ordinary strings as local paths; a `Buffer` makes the intended byte-only path explicit. [Node image loader](https://github.com/naptha/tesseract.js/blob/master/src/worker/node/loadImage.js), [image type declaration](https://github.com/naptha/tesseract.js/blob/master/src/index.d.ts)

Tesseract.js has no `AbortSignal` input in its current declarations. On an already-aborted signal, reject before creating/starting work. While recognition is active, an abort listener should terminate the worker, reject with the library's normalized abort error, mark the worker unusable, and let the next non-aborted call create a fresh one. Race/catch the underlying recognize promise so termination does not produce an unhandled rejection. `worker.terminate()` is documented as terminating and cleaning up the worker; abort behavior still needs direct runtime tests. [Worker API/types](https://github.com/naptha/tesseract.js/blob/master/docs/api.md), [official declarations](https://github.com/naptha/tesseract.js/blob/master/src/index.d.ts)

## Offline/local data and dependency decision

Do not rely on Tesseract.js defaults: its official documentation says that with no `langPath`, language data is downloaded from jsDelivr, and the API describes gzip-compressed traineddata as the default. Require an explicit local traineddata location in the adapter factory, pass it as `langPath`, use a local package worker/core path where needed, and make the `.traineddata`/`.traineddata.gz` setting explicit with `gzip: false` for uncompressed files or `gzip: true` for compressed files. Never provide a CDN fallback. The Node-specific documentation says language path is the path normally customized in Node; verify how local data package paths resolve with the exact package version before implementation. [Local-installation docs](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md), [API options](https://github.com/naptha/tesseract.js/blob/master/docs/api.md)

**Exact research candidate, not an accepted pin:** `tesseract.js@7.0.0`; its package metadata declares Apache-2.0, Node 16+ and a dependency range `tesseract.js-core: ^7.0.0`. npm metadata currently reports unpacked sizes of 1,411,341 bytes for tesseract.js and 45,262,431 bytes for `tesseract.js-core@7.0.0`. These are unpacked package figures, not compressed transfer sizes or an adapter bundle measurement. The same package metadata includes a `postinstall` script invoking `opencollective-postinstall`; this conflicts with the repository's no-install-scripts rule and is a **dependency approval blocker** until resolved by a permitted dependency decision. Do not silently accept it or imply ADR 0011 covers the plugin package. [Official package metadata](https://github.com/naptha/tesseract.js/blob/master/package.json), [npm tesseract.js 7.0.0](https://www.npmjs.com/package/tesseract.js/v/7.0.0), [npm core 7.0.0](https://www.npmjs.com/package/tesseract.js-core/v/7.0.0)

Language data should remain user-provided or an explicitly optional model package, not bundled into the core or adapter by default. The official `@tesseract.js-data/eng@1.0.0` package reports MIT and 13,876,967 unpacked bytes, while the upstream `naptha/tessdata` repository is labeled Apache-2.0. Resolve the package/file license and model provenance before recommending or bundling it. No language pack is pinned in this proposal. [Official tessdata repository](https://github.com/naptha/tessdata), [npm English data metadata](https://www.npmjs.com/package/@tesseract.js-data/eng/v/1.0.0)

Unresolved dependency review items: package/install-script policy, licenses for transitive dependencies and the selected model, maintainer/security health, exact lockfile pin (including the core transitive), packed install size, and measured adapter-only bundle size. npm metadata above was read without installing packages. No runtime dependency was added.

## Required validation before implementation/acceptance

- Unit tests with a mocked worker: input bytes become a `Buffer`; page and word confidence scale correctly; boxes map correctly; empty OCR is accepted; repeated calls reuse one worker; calls serialize; language changes reinitialize; `dispose()` terminates; max-job recycle terminates/recreates; cancellation before/during work terminates and prevents reuse of the old worker.
- Node integration with explicitly local English traineddata and the synthetic scanned-PDF/image fixture: OCR recovers a known phrase. Keep this slow/opt-in if model files are not committed. A Tesseract CLI result does not validate the Tesseract.js worker adapter.
- Network test: stub global fetch and fail any HTTP(S) socket creation; verify a valid local model succeeds with zero network attempts and missing model data fails locally without trying a CDN. Test worker/core/model resolution with the exact pinned package tree.
- Security: verify image bytes are the only recognition input; no URL/path load, no document JS/actions execution, no logs or error/warning contents containing image bytes or passwords, worker termination on abort, bounded pixel/input/job processing where the provider contract allows it.
- Integration once blockers clear: PDF `needsOcr` page and stats/warnings, embedded image selection, child images only when requested, confidence warning semantics, location mapping, and no regression in core subpath bundle size. This cannot be validated before #45/#41/#74.
- Record `docsluice` core and OCR subpath bundle sizes separately, cold worker initialization, warm per-image time, peak memory, repeated-job recycling, language pack bytes, and OCR accuracy on a human-reviewed sample. Do not use a CLI benchmark as adapter acceptance.

## Fixture tool availability

Available locally: `pdftotext`, Python `pypdf 6.10.0`, and the Tesseract CLI. `qpdf`, `mutool`, and LibreOffice are unavailable. The separate `pdf-fixtures/advanced/` preparation set uses pypdf only as a fixture-generation/inspection tool; it does not add a repository dependency or count as engine/adapter validation.
