# Streaming extraction

`extractStream(input, options)` returns an async iterable of top-level blocks. Its
`result` promise resolves to the completed document, including metadata, warnings,
statistics and child documents. When iteration drives an incremental reader, emitted
root blocks are not retained in the result (`result.blocks` is empty); use the yielded
blocks for content. Reading `result` before starting iteration follows ordinary
extraction and retains the complete `blocks` array.

```ts
const stream = extractStream(file.stream(), { filename: 'records.csv' });
for await (const block of stream) {
  render(block);
}
const document = await stream.result;
```

Incremental readers use a bounded input prefix for format detection, then receive
the same prefix followed by the remaining input bytes through `ReadContext.input`.
They emit a top-level block and `await ctx.out.flush()` before continuing. The
iterator has at most one queued block; a reader that exceeds that bound without
flushing fails with a generic reader error. Breaking out of the loop aborts the
private extraction scope, cancels a pending input read and releases its stream
lock. The result promise rejects with `AbortError` after early termination. An open
section is assembled until its closing call, and a table is assembled as one block;
readers should keep those structures bounded or emit smaller top-level blocks.

Readers may provide `readStream(ctx)` when their format can be parsed
incrementally. The current built-in DOC reader uses the whole-byte `read(ctx)`
contract. Text formats such as TXT, CSV, NDJSON and EML can use the incremental
reader contract; each format becomes incremental once its reader implements
`readStream`. Readers without it receive a fully materialized byte array under
the normal input-byte limit, and their blocks are yielded after extraction
finishes. This fallback preserves legacy reader behavior but cannot stop parsing
early or provide parser-to-consumer backpressure.

Reading `stream.result` before starting the iterator runs the ordinary
whole-document extraction path. Iterate first when progressive results,
backpressure or early cancellation are required. Children stay on the parent
document's `children` result and are not yielded as root blocks.
