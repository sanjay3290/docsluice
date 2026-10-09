# PDF advanced API probe (preparation only)

This folder contains a research harness for PDF issues #47, #49 and #50, plus an original synthetic embedded-attachment fixture. It does not implement a reader and does not satisfy the PDF spike / #45. The frozen baseline archive was unavailable, so the issue snapshot at ../../current-issues.json and scaffold inputs in the repository (AGENTS.md, docs/prd.md, ADR 0009 and ADR 0011) were used as preparation context. No repository files or dependencies were changed.

## Candidate and source boundary

The probe used the already-present /tmp/docsluice-unpdf-only package (unpdf@1.7.0) solely as a research candidate. Its own README says the bundled serverless PDF.js is 5.6.205. This is not an accepted version pin: ADR 0011 allow-lists unpdf, but has no exact version; ADR 0009 is Proposed and requires the separate cross-runtime/size/security spike. No install or dependency edit was performed.

Primary sources: [unpdf v1.7.0 README](https://github.com/unjs/unpdf/blob/v1.7.0/README.md), [unpdf v1.7.0 source](https://github.com/unjs/unpdf/blob/v1.7.0/src/index.ts), [PDF.js v5.6.205 display API](https://github.com/mozilla/pdf.js/blob/v5.6.205/src/display/api.js), [PDF.js shared permission flags](https://github.com/mozilla/pdf.js/blob/v5.6.205/src/shared/util.js), and [PDF.js annotations](https://github.com/mozilla/pdf.js/blob/v5.6.205/src/display/annotation.js). The installed declarations at the candidate package were also inspected. The unpdf v1.7.0 README notes that official PDF.js 5.x uses Promise.withResolvers (not supported by Node versions below 22), while the serverless bundle includes a polyfill; this still requires exact-version Node 20/22/24 smoke testing. The probe calls no viewer, annotation editor, open action, JavaScript action or rendering method.

## API findings

The package exports getDocumentProxy(data, options?) and getResolvedPDFJS(). The declaration/API does not export getPDFProxy. The README's documented low-level path is: getResolvedPDFJS(), then getDocument(new Uint8Array(bytes), options).promise. The same PDF.js PDFDocumentProxy is exposed by getDocumentProxy and provides these APIs:

| Need | Call and observed shape |
|---|---|
| Password / metadata | getDocumentProxy(bytes, { password }); getMetadata() returns { info, metadata }. In the encrypted fixtures info.EncryptFilterName is "Standard"; in the unencrypted form fixture it is null. info.IsEncrypted was absent. getPermissions() returned null for unencrypted input and an array for encrypted input. |
| AcroForm | pdf.getFieldObjects() returns null or an object keyed by field name whose values are arrays. Text and checkbox records included name, type, value, defaultValue, id, page, rect, editable, hidden, actions, and type-specific fields. The synthetic checkbox source has /Yes; PDF.js normalized its returned value to "Yes". |
| Page annotations | const page = await pdf.getPage(n); await page.getAnnotations({ intent: 'display' }) returns records with subtype, contentsObj.str, titleObj.str, rect, id, flags, appearance/presentation fields and, where applicable, textContent. The two source annotations produced Text and FreeText records. titleObj.str is the author and must be suppressed when metadata is disabled. These records are data; do not follow annotation actions or URLs. |
| Attachments | pdf.getAttachments() returned an ordinary object keyed by PDF name-tree keys; values had { filename, content: Uint8Array }. Distinct keys with the same filename both survive. An exact __proto__ key was observable in Object.entries; the API shape is a plain object, not a safe output model. Convert entries to an array immediately, preserve duplicate filenames without overwriting, and never use a PDF-derived value as a filesystem path or an ordinary-object key. |

getPermissions() is declared Promise<Array<number> | null>. For both encrypted fixtures (empty user password/owner-only and correct user password) it returned [4,8,16,32,256,512,1024,2048]. In the installed PDF.js declarations these correspond to PRINT, MODIFY_CONTENTS, COPY, MODIFY_ANNOTATIONS, FILL_INTERACTIVE_FORMS, COPY_FOR_ACCESSIBILITY, ASSEMBLE, and PRINT_HIGH_QUALITY. This fixture does not test a restricted permission combination. It does show that permissions are not a standalone reliable encrypted bit: use info.EncryptFilterName as an observed signal in addition to permission state, then verify against a broader corpus. Do not add a permission-override option without lead decision.

## Password and damaged-file observations

Observed candidate behavior on local fixture bytes:

| Case | Candidate result |
|---|---|
| Encrypted owner-password fixture, empty user password | Opened; EncryptFilterName: Standard; permissions array present. |
| User password fixture, no password option | Rejected as PasswordException, code 1, static message No password given. |
| Correct synthetic user password | Opened; encrypted metadata signal and permissions array present. |
| Wrong synthetic password | Rejected as PasswordException, code 2, static message Incorrect Password. |
| Truncated hostile fixture | Rejected before page access as InvalidPDFException, static message Invalid PDF structure. |
| Corrupt-xref hostile fixture | Recovered a document with 3 pages; emitted static parser warnings including Indexing all PDF objects and an invalid-root xref warning. Page 1 text call succeeded. |

The password values were not serialized into results. A future adapter should branch on the PDF.js password exception codes, map them to the project error enum, and ensure error messages/warnings/logs contain neither credentials nor document text. stopAtErrors:false was used for recovery observation; a successful load or page-1 extraction does not establish page-level partial recovery. Test each page and distinguish warnings from complete extraction. Parser warnings are emitted through console.warn by this candidate and must not leak from the public library; capture/normalize fixed messages at the adapter boundary if needed.

## Security configuration observed

probe.mjs passed local Uint8Array bytes, never a URL, with these options:

    isEvalSupported: false,
    useWasm: false,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    stopAtErrors: false

The DocumentInitParameters declarations document these options. unpdf documents isEvalSupported:false as a default and forwards caller options. The harness replaced global fetch, eval, Function, and Worker with counting guards before import/parsing; counts were all zero on this run. This is only a bounded instrumentation observation on this Node version: it is not a formal proof of no network/evaluation across runtimes. PDF.js still exposes a PDFWorker abstraction; the guard shows no global Worker constructor invocation, not that its internal parser worker abstraction is disabled. The unpdf README describes worker code inlined in its serverless build. There is no disableWorker switch in the inspected init declaration. Confirm the intended no-worker requirement at the #45 spike boundary; do not infer it from this probe. useWasm:false is essential to satisfy the repository's no-WebAssembly-in-core rule. Do not call renderPageAsImage/extractImages through unpdf; its declarations import optional @napi-rs/canvas types. Keep the PDF dependency surface to text/low-level display API. For XFA-only detection, PDF.js exposes the page/document proxy property isPureXfa; test it before treating absent AcroForm objects as an empty form.

## Fixture and measurement files

- ../../pdf-fixtures/advanced/generated/ has the original form, annotation and password PDFs with source facts and CC0 sidecars.
- ../../pdf-fixtures/attachments/attachments-edge-cases.pdf is generated by generate-attachments.py using Python standard library only. It embeds CSV, a deterministic nested ZIP, two distinct filespec/name-tree keys sharing data.csv, a traversal filename, and an exact __proto__ name-tree key and filename. It uses a fixed PDF ID, fixed object order and ZIP timestamp. test_attachments.py checks byte-for-byte repeat generation, xref object offsets, sourcefacts and pypdf payload reads. This generator does not create an archive quine or claim reader acceptance.
- probe.mjs and probe-results.json record the local method/shape and summarized results; raw attachment bytes are replaced by lengths and object shape in the JSON.

## Next validation matrix for #45 / adapter integration

Before acceptance, run the pinned candidate and the same tests on every supported runtime (Node 20/22/24, Bun, Deno, browser/edge target as declared). Keep local bytes, disable URL/range/stream/autofetch/worker fetch, set isEvalSupported:false, useWasm:false, and instrument fetch, XHR, Worker, eval, and Function. Test that no UI/action APIs are invoked, including getOpenAction, getJSActions, and annotation action dispatch. Exercise the password cases above plus unsupported encryption; verify sanitized EncryptedError codes and feature metadata. Test text/checkbox/radio/choice/XFA-only fields, annotations with metadata on/off, duplicate/path/__proto__ attachments, corrupt xref/truncation/content-stream corruption, per-page recovery, aborts, page/item/byte/output budgets and warnings.

For bounded performance, use the same fixed corpus and runtime image; run one cold parse and at least five warm repetitions per file, discard no failures, report median and max wall time and peak RSS, and record input/output/item/page counts. Enforce hard page/item/time/output ceilings in the adapter so hostile files stop predictably. Measure the actual dependency delta from clean lockfile installs on Node 20/22/24: compressed package tarball and installed transitive bytes, report both and the exact lockfile graph. No package-size or runtime performance measurement was made here. These results must be reviewed in ADR 0009 before selecting or pinning a runtime version.

## Status

This is preliminary API research against unpdf@1.7.0 / bundled PDF.js 5.6.205 only. It does not verify supported-runtime compatibility, no-worker operation as defined by ADR 0009, parser safety, bounded resource use, table/order accuracy, production dependency size, or reader acceptance; it does not complete #44/#45 or accept ADR 0009. The static results are an adapter/test design aid, not a feature claim.
