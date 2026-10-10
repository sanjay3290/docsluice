# EML

EML files use RFC 5322 headers and MIME bodies. The reader unfolds headers, decodes RFC 2047 encoded words, parses RFC 2231 content parameters, and decodes base64 and quoted-printable parts. `text/plain` is preferred in multipart alternatives; HTML is passed through the HTML reader when there is no plain-text alternative. Mixed text parts remain in MIME order.

Detection recognizes a message by its header block: the text must open with RFC 5322 header fields (folded lines allowed) and at least two of them must be message headers such as `From`, `To`, `Subject`, `Date`, `Message-ID`, `MIME-Version` or `Received`. Files with an `.eml` name or a `message/rfc822` type that fail this check stay text and get a `FORMAT_MISMATCH` warning.

The header block is a two-column `table` (field, value). Subject is `metadata.title`. A date in RFC 5322 form, including obsolete two-digit years and zone names such as `EST`, becomes ISO 8601 UTC in `metadata.created` and the table; the parser is hand-written, so the result never depends on the JavaScript engine or the host time zone. A date without a zone or in another form stays as text in the table and leaves `metadata.created` unset.

Subject and date are retained as document metadata. Sender, recipient, and copied-recipient values appear in the header table and sender metadata only when `metadata` is enabled. Attachments are sent through the normal child-document pipeline, so extracted children share the parent's limits. Inline images remain child documents and are represented by image references; the parser does not inline image bytes into text.

MIME parts are scanned iteratively and bounded by the 1 MiB per-header cap, a multipart nesting cap of 64 levels (`DEPTH_LIMIT` warning; `xmlDepth` applies when it is lower, with a `TRUNCATED` warning), the shared entry and uncompressed-byte allowances, output limits, and the shared time/abort budget. Transfer decoding preflights the shared uncompressed allowance before allocation; text is decoded in chunks and stops at the remaining output allowance. A missing closing boundary produces an `UNREADABLE_PART` warning when readable content remains.

Support is best effort. This reader does not validate signatures, decrypt encrypted mail, fetch remote content, or process S/MIME. Outlook `.msg` files have their own reader with the same output shape: see [msg.md](msg.md).
