# MBOX

The MBOX reader (`docsluice/mbox`) reads Unix mailboxes (RFC 4155): the `.mbox` files written by Thunderbird, mutt, Apple Mail exports and Google Takeout. The mailbox gives one child per message. The mailbox document itself has no blocks.

## Detection

A file is `mbox` when:

- it starts with a `From ` envelope line, and the next lines form an RFC 5322 header block with at least two message headers; or
- the hint is an `.mbox` name or `application/mbox`.

Text that only starts with "From " stays text.

## Messages

- A message starts at the first line, and at every `From ` line that follows an empty line (LF or CRLF).
  - A `From ` line inside a paragraph is body text.
  - The envelope line is dropped.
  - The empty line before the next envelope is dropped.
- mboxrd quoting is undone: a line of one or more `>` followed by `From ` loses one `>`. mboxo files, which never quoted, read the same way, except that their body `From ` lines after an empty line start a new message (the format cannot tell them apart).
- Each message is the child `message-N.eml` (1-based, in mailbox order) with the hint `message/rfc822`. The EML reader reads it ([eml.md](eml.md)), and its attachments are its own children (`message-3.eml/readings.csv`). Options such as `quotedReplies` apply to every message.
- `children: 'list'` lists the messages with their sizes without reading them. `children: 'skip'` adds nothing.
- A file read as `mbox` without any envelope line gives no children and one `UNREADABLE_PART` warning.

## Safety

- One pass over the lines finds the envelopes. Each message is copied once, with its quoting removed.
- Every message counts against `zipEntries`, and its bytes against `totalUncompressedBytes`. The messages' MIME parts count against `zipEntries` too, all under the shared budget (NST-1).
- At a limit, the listing stops with `TRUNCATED`.

## PST

Outlook `.pst` mailboxes are detected (`pst`) and fail with `UNSUPPORTED_FORMAT`. [ADR 0015](../adr/0015-pst.md) explains why PST is left to a future opt-in plugin.

## Corpus and generators

- `scripts/corpus/make-mbox.mjs` writes `corpus/mbox/mailbox.mbox`: three messages, mboxrd quoting, a body `From ` line, and an attachment.
- `scripts/hostile/generate-mbox.mjs` writes `hostile/mbox`:
  - 6,000 messages (`TRUNCATED` at `zipEntries`);
  - 20,000 lines of nested `>From ` quoting.
