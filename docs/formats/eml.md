# EML

EML files use RFC 5322 headers and MIME bodies. The reader unfolds headers, decodes RFC 2047 encoded words, parses RFC 2231 content parameters, and decodes base64 and quoted-printable parts. `text/plain` is preferred in multipart alternatives; HTML is passed through the HTML reader when there is no plain-text alternative. Mixed text parts remain in MIME order.

Subject and date are retained as document metadata. Sender, recipient, and copied-recipient values appear in the header table and sender metadata only when `metadata` is enabled. Attachments are sent through the normal child-document pipeline, so extracted children share the parent's limits. Inline images remain child documents and are represented by image references; the parser does not inline image bytes into text.

MIME parts are scanned iteratively and bounded by the 1 MiB per-header cap, `xmlDepth`, the shared entry and uncompressed-byte allowances, output limits, and the shared time/abort budget. Transfer decoding preflights the shared uncompressed allowance before allocation; text is decoded in chunks and stops at the remaining output allowance. A missing closing boundary produces an `UNREADABLE_PART` warning when readable content remains. Quoted reply removal is available as the independent `dropQuotedReplies(text, budget)` helper; no public extraction option is defined until the core options owner adds the approved `quotedReplies` option.

Support is best effort. This reader does not validate signatures, decrypt encrypted mail, fetch remote content, or process S/MIME. It does not parse Outlook MSG containers.
