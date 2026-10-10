# Rich Text Format (RTF)

The RTF reader (`docsluice/rtf`, detected from the `{\rtf` signature, MIME `application/rtf` or `text/rtf`) reads the control stream in one iterative pass. Every `{...}` group carries its own state: character formatting, paragraph formatting, and a destination that decides where the group's text goes. It gives the same block shapes as the DOCX and ODT readers. `test/readers/rtf/parity.test.ts` compares the LibreOffice RTF and DOCX exports of the same four sources.

## What is read

- **Text and encodings.** Hex escapes (`\'hh`) and text bytes are decoded with the current font's `\fcharset`, else the document's `\ansicpg`, `\ansi`, `\mac` or `\pc` code page. Signed `\uN` values are read with `\ucN` fallback skipping; values outside -32768..65535 are ignored with `UNREADABLE_PART`. `\upr` groups use their Unicode copy (`\*\ud`). Code pages map to Windows-1250 through 1258, Windows-874, Shift-JIS, GBK, EUC-KR, Big5 and UTF-8 when the runtime's `TextDecoder` supports them. Anything else falls back to Windows-1252 with `ENCODING_GUESSED`. Symbol-font text (`\fcharset2`) is decoded as Windows-1252 without a warning. `encoding` reports the document code page.
- **Headings.** `\outlinelevelN` (0 to 8) gives heading level N+1, capped at 6. Otherwise a paragraph style (`\sN`) is a heading when the style sheet names it `heading N` or gives it an outline level. Style numbers alone mean nothing, because each document numbers its styles.
- **Lists.** A paragraph with `\lsN` (or a `\listtext`/`\pntext` label) is a list item. `\ilvlN` sets its nesting level, and a change of `\ls` starts a new list. The item's marker is its `\listtext` label: `1.`, `a)` or `iv.` make the list ordered. Symbol-font and middle-dot bullets become `•`. A paragraph that starts with `\bullet` and has no label uses `•` as its marker.
- **Tables.** Rows come from `\trowd`, `\cellx`, `\cell` and `\row`; `\intbl` is implied by a row definition. The grid follows the DOCX convention: one cell per grid column, from the union of all `\cellx` boundaries. A cell that covers several columns gets `colSpan`; `\clmgf`/`\clmrg` and `\clvmgf`/`\clvmrg` give horizontal and vertical spans. Each covered position is an empty cell. One level of nested tables (`\itap2`, `\nestcell`, `\nestrow`, `\*\nesttableprops`) adds its text to the outer cell. The nested table is also emitted as its own block after the outer table.
- **Notes.** `\footnote` gives a `footnote` note, or an `endnote` with `\ftnalt`. `\annotation` gives a `comment` note with its `\atnauthor` as author; authors are removed with `metadata: false`. Notes, and pictures, follow the paragraph, list or table that holds their anchor.
- **Headers and footers.** `\header*` and `\footer*` groups become `header` and `footer` blocks, each distinct text once: headers first, footers after the body.
- **Fields and objects.** A field's `\fldrslt` is text; `\fldinst` is not. `\object` sets `features.hasEmbeddedFiles` and contributes only its rendered `\result`. Object data is never extracted or run.
- **Pictures.** `\pict` (inside `\*\shppict` when present; `\nonshppict` duplicates are skipped) becomes an `image` block. Its hex or `\bin` data is decoded under the `totalUncompressedBytes` allowance and listed as a child `imageN.<ext>`, with bytes only when `childBytes` is set. The type comes from `\pngblip`, `\jpegblip`, `\emfblip`, `\wmetafile` and similar. The size is `\picwgoal`/`\pichgoal` times `\picscalex`/`\picscaley`, in pixels at 96 dpi. A picture cut short by the allowance or by a `\bin` that runs past the end of the file is not listed (`UNREADABLE_PART`).
- **Revisions and hidden text.** `\revised` (inserted) and `\deleted` text follow the `revisions` option, with `[+…+]` and `[-…-]` in `show` mode. `\v` hidden text is left out unless `includeHidden` is set. Each case adds a `HIDDEN_CONTENT` warning.
- **Metadata.** `\info` title, author, subject, keywords, comments (`\doccomm`), and valid creation and revision times, also when WordPad-style files place these groups after an ungrouped `\info`.
- **Runs.** With `runs: true`, bold and italic runs are kept.

## Limits and safety

Groups nest like elements and share the `xmlDepth` limit. Deeper groups are skipped whole, including their `\bin` data, with `TRUNCATED`. `\binN` payloads are skipped by their declared length and never read past the end of the input; an overrun adds `UNREADABLE_PART`. Control words longer than 64 letters are ignored. Text waiting in paragraphs, cells, lists and notes is staged against `outputChars`, and grid cells are charged to `cells`. An unterminated document keeps the text read before the end.

The reader skips formatting tables (`\colortbl`, `\listtable`, `\revtbl`, `\themedata` and similar), field instructions, bookmarks, shape properties and every unknown `\*` destination. Unknown destinations without `\*` are read as text, as the specification asks.

## Known gaps

- Hyperlink targets are not kept as link runs; only the link text is read.
- List numbering is taken from the producer's `\listtext` labels; `\listtable` definitions are not resolved.
- Text boxes and shape text (`\shptxt`) are skipped.
- LibreOffice's RTF export itself loses some structure that DOCX keeps: a custom outline level on a style without a heading name, and the outer `\cell` after a nested table. The parity test lists both.

## HTML in RTF

The reader module also exports `deencapsulateRtfHtml(bytes, budget)` for MSG body reconstruction. It follows the [MS-OXRTFEX recognition](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxrtfex/3cf14977-3883-404a-8ed8-57c99263fb76) and [HTML extraction](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxrtfex/906fbb0f-2467-490e-8c3e-bdc31c5e9d35) rules for `\fromhtml` in the first ten RTF tokens, `\htmltag` fragments, ignored `\mhtmltag` fragments, and `\htmlrtf` suppression. It applies the shared work, depth and output budgets, and it returns `undefined` for ordinary RTF or when bounded extraction cannot complete. The returned HTML is inert text: callers must pass it through their normal safe HTML reader and must never run it.
