# PowerPoint 97–2003 (PPT)

The reader consumes the integrated CFB reader and extracts the live presentation's ordered slides, title placeholders, body text and speaker notes. It accepts a reused CFB index in `ReadContext.cfb`. Each slide is a `section` with role `slide` and a 1-based `loc.slide`; title text is also a heading, and notes use role `speaker-notes`. Child-document paths are retained in every location.

The live persist directory selects the most recent version of each object. Deleted and stale text elsewhere in the stream is not scanned into output. TextCharsAtom is UTF-16LE; TextBytesAtom contains Unicode low bytes, not Windows-1252 text. Macros and formulas are never executed and external content is never fetched.

Malformed required stream/edit structure raises `CORRUPT_FILE`; an unreadable slide part can be skipped with `UNREADABLE_PART`. Encrypted files raise `ENCRYPTED`. Record boundaries, edit chains, persist counts, tree depth, decoded text, time and cancellation are checked under the shared budget. Output truncation uses `TRUNCATED`, or `LIMIT_EXCEEDED` with `onLimit: 'throw'`.

This initial reader focuses on text and notes. It does not render graphics, animations or charts, reconstruct tables from visual drawing geometry, or decrypt PPT. Master-slide text is not emitted as slide text. Visual shape reading order and rich formatting are not promised for legacy PPT.

The self-authored CC0 fixture `corpus/ppt/order-title-notes.ppt` was exported with LibreOfficeDev 26.8.0.0.alpha0 using the MS PowerPoint 97 filter. It checks three-slide order, Unicode text, notes, and the first slide's title. That exporter preserves title-like text on the other two slides as ordinary text shapes; no placeholder title is inferred from appearance.

The reader enforces a conservative internal cap of 100,000 object reservations per parse, including persist entries, slide descriptors, text chunks and traversal frames. Reservations are cumulative and are not released when temporary objects are discarded. Exceeding the cap raises `LIMIT_EXCEEDED` with limit `pptObjects`. This prevents record-count amplification even when records hold no text. It is independent of configurable byte, character and depth budgets.

The LibreOffice input has a reviewed direct-reader JSON golden. Three deterministic hostile mutations have direct-reader tests, and a reader fuzz target exercises valid, truncated and mutated inputs.

Registration in the public extraction pipeline, shared manifest entries and JSON/Markdown integration goldens are supplied by the integration lead. This module's direct-reader regression and fixture tests do not establish those integration gates. The source and hostile regeneration recipe are in `packages/docsluice/test/readers/ppt/fixtures/`.

Sources: [MS-PPT live-record selection](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-ppt/1fc22d56-28f9-4818-bd45-67c2bf721ccf), [TextHeaderAtom](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-ppt/08d31a66-0750-4009-b416-49f2871cd178), [TextBytesAtom](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-ppt/80aae34b-2699-43fa-9e6a-c560ae790cd7).
