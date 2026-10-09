# Upload handling

The [runnable source](https://github.com/sanjay3290/docsluice/blob/fix/package-a-docs-site/packages/docsluice/examples/site/upload.ts) accepts a browser `File`, checks its declared size before materializing the body, uses a 25 MB input budget and 15-second time budget, suppresses supported personal metadata, and lists child documents rather than opening them. In a server, enforce request-body limits before constructing the byte array, then pass a bounded `Uint8Array` to `extract`.

The recipe's test uses the real legacy DOC fixture in a browser-compatible `File` object. The full uploaded bytes are copied into memory by `File.arrayBuffer()`; for streaming server inputs, use the Node helper and retain a transport-level size cap.
