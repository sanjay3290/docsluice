# NDJSON

The NDJSON reader (`docsluice/ndjson`) reads newline-delimited JSON (JSON Lines, `.ndjson`, `.jsonl`). Each non-blank line is one record and is read like the [JSON](json.md) reader reads a document: its scalar leaves become `path: value` paragraphs, rooted at `$[n]` for the n-th record (`$[2].species: wren`).

- **Detection**: two or more lines that are each a JSON object or array (the last line of the detection sample may be cut short). A `.ndjson`/`.jsonl` name or `application/x-ndjson` type also selects it when the content looks like plain text.
- **Damage**: a line that is not valid JSON is skipped; one `UNREADABLE_PART` warning gives the count. A record nested deeper than `blockDepth` is skipped before `JSON.parse` sees it, with one `DEPTH_LIMIT` warning.
- No pretty-printed code block is added (unlike the JSON reader). A streaming consumer can apply backpressure every 256 records.

`hostile/ndjson` holds deep records and a large record count.
