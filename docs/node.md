# Node entry (`docsluice/node`)

`docsluice/node` re-exports everything from `docsluice` and adds Node-only inputs. The core stays runtime-neutral (RT-2); only `src/node/` imports `node:` modules.

```js
import { extract, extractFile } from 'docsluice/node';

const doc = await extractFile('./report.csv', { limits: { inputBytes: 10_000_000 } });
const fromStream = await extract(fs.createReadStream('notes.md'), { filename: 'notes.md' });
```

## `extractFile(path, options)`

`path` is a string or a `file:` URL. `extractFile` reads the file's size with `fs.stat` and throws `LimitExceededError` (`inputBytes`) before opening the file when it is too large. It then streams the file through the normal input budget, which also catches a file that grows after the size check. The file's base name is the `filename` hint unless `options.filename` is set. File-system errors (for example `ENOENT`) propagate unchanged.

## Node `Readable` and `Buffer` input

The Node `extract` also accepts a Node `Readable` and a `Buffer`. A `Readable` is converted with `Readable.toWeb`, and each chunk is copied into a plain `Uint8Array`, so no `Buffer` reaches the core. The core stream reader enforces `inputBytes` and observes `options.signal`. On overflow, abort, a non-byte (object-mode) chunk, or a setup error, the adapter cancels the web stream and destroys the `Readable`. Every other input passes to the core `extract` unchanged.

For extraction in an isolated worker thread with heap and time limits, see [worker.md](worker.md) (`docsluice/worker`, SEC-13).
