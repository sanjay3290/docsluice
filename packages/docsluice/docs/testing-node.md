# Testing Node inputs

The `docsluice/node` entry point adapts Node-only inputs at the runtime boundary. Core extraction continues to accept byte arrays, blobs, and web streams; Node callers can pass a `Readable` or use `extractFile(path, options)`.

`extractFile` stats the path first and compares its size with the effective `inputBytes` limit before opening a read stream. It then streams the file through the normal input budget, using the basename as the filename hint unless the caller supplied `options.filename`. The stream path also enforces the limit against bytes actually read, which covers files that grow after the stat check. File-system errors propagate to the caller.

Node `Readable` inputs are converted with `Readable.toWeb`. Each emitted byte chunk is copied into a plain `Uint8Array` before core receives it, so Node `Buffer` objects do not cross the boundary. The core stream reader enforces `inputBytes`, observes `options.signal`, cancels the web reader, and releases its lock. The adapter tests verify overflow and abort cleanup as well as successful file and stream extraction.

Run the focused tests and Node typecheck with:

```sh
npm test -- --run test/node/file.test.ts
npm run typecheck
```

The focused test uses `createExtractor` with a test-local `ReaderRegistry`, so it verifies the real core pipeline without depending on a built-in CSV reader or adding a production reader registration.
