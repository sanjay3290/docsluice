# MSG

The MSG reader (`docsluice/msg`) reads Outlook `.msg` files ([MS-OXMSG]): a compound file (see [ole.md](ole.md)) detected by its root `__properties_version1.0` stream. The output has the same shape as [EML](eml.md):

- A two-column header `table` (field, value): From, To and Cc (only when `metadata` is enabled), Date and Subject. Subject is `metadata.title`, the sender is `metadata.authors`, and the date is `metadata.created`.
- One body, then attachments as child documents.

## Headers

- **From**: `PR_SENDER_NAME` with `PR_SENDER_SMTP_ADDRESS` (else `PR_SENDER_EMAIL_ADDRESS` when it is an SMTP address), as `Name <address>`. A message without a sender falls back to the sent-representing name and address.
- **To / Cc**: the recipient storages (`__recip_version1.0_#…`) in name order, by `PR_RECIPIENT_TYPE` (1 To, 2 Cc; Bcc is not shown), each as `Name <address>` from `PR_DISPLAY_NAME` and `PR_SMTP_ADDRESS` or `PR_EMAIL_ADDRESS`. Without recipient storages, `PR_DISPLAY_TO` and `PR_DISPLAY_CC` are used.
- **Date**: `PR_CLIENT_SUBMIT_TIME`, else `PR_MESSAGE_DELIVERY_TIME`, converted from FILETIME to ISO 8601 UTC.

String properties use the Unicode stream (`001F`) when present. 8-bit strings (`001E`) are decoded in `PR_MESSAGE_CODEPAGE`, else `PR_INTERNET_CPID`, else Windows-1252. An unsupported code page falls back to Windows-1252 with one `ENCODING_GUESSED` warning.

## Body

The first non-empty body wins:

1. `PR_BODY`: plain text, split into paragraphs on blank lines.
2. `PR_HTML`: decoded in `PR_INTERNET_CPID` and passed through the safe HTML reader. `cid:` image references point at the matching attachment child (`PR_ATTACH_CONTENT_ID`).
3. `PR_RTF_COMPRESSED`: decompressed ([MS-OXRTFCP] LZFu, or the uncompressed `MELA` form). RTF that encapsulates HTML (`\fromhtml1`, [MS-OXRTFEX]) becomes HTML; other RTF goes through the [RTF reader](rtf.md).

With `quotedReplies: 'drop'`, plain and HTML bodies (including HTML encapsulated in RTF) lose their quoted reply history by the rules in [eml.md](eml.md#quoted-reply-history-eml-4). Plain RTF bodies are read whole.

A compressed RTF body that fails its CRC, is cut short or holds less than its declared size keeps the text read so far, with an `UNREADABLE_PART` warning.

## Attachments

Attachment storages (`__attach_version1.0_#…`) are read in name order and sent through the normal child pipeline, so children share the parent's budget and depth limit (NST-1, NST-2):

- **By value** (`PR_ATTACH_METHOD` 1): the `PR_ATTACH_DATA_BIN` stream. The name is `PR_ATTACH_LONG_FILENAME`, else `PR_ATTACH_FILENAME`, else `PR_DISPLAY_NAME`, cleaned of separators and control characters. `PR_ATTACH_MIME_TAG` is the child's MIME hint.
- **Embedded message** (method 5): the `__substg1.0_3701000D` storage is copied into a compound file of its own (its 24-byte property header becomes the 32-byte top-level header) and read as a nested `.msg` child. `.msg` is added to the name when missing.
- **OLE object** (method 6): the object storage is copied into a compound file of its own and passed on as a child.
- Attachments stored by reference, or without data, are not included; one `UNREADABLE_PART` warning gives their count.

`children: 'list'` lists attachments with their sizes without opening them; `children: 'skip'` reads no attachment data. Both still set `features.hasEmbeddedFiles`.

## Safety

- The compound file reader bounds sectors, chains, directory loops and depth ([ole.md](ole.md)); a directory loop through an attachment is `CORRUPT_FILE`.
- LZFu output is sized from what the input can produce (at most 8 bytes per input byte), never from the declared raw size, and is charged to `totalUncompressedBytes` and the compression-ratio limit before allocation.
- A copied embedded message is charged to `totalUncompressedBytes`, so deep nesting cannot multiply work past the shared limit; `childDepth` stops nesting with `DEPTH_LIMIT`.
- Property streams are read once per storage into a `Map`; every loop ticks the budget. Warnings carry counts and code pages only, never message content.

Not supported: named properties, signed or encrypted (S/MIME) messages, Outlook items other than mail (appointments, contacts and tasks are read as mail with whatever subject and body they have).

## Corpus and generators

`corpus/ole/test_outlook_msg.msg` is an Outlook-produced message. `scripts/corpus/make-msg.mjs` writes the self-made files in `corpus/msg` (plain body with recipients and attachments, HTML with a `cid:` reference, encapsulated HTML in compressed RTF, 8-bit strings in code page 1251, and an embedded message), and `scripts/hostile/generate-msg.mjs` writes `hostile/msg`. Both use `scripts/corpus/msg-writer.mjs`, which writes compound files with docsluice's own CFB writer (`src/ole/write.ts`).
