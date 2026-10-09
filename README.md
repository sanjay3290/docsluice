# docsluice

Safe, structured document extraction for every JavaScript runtime.

```ts
import { extract, toJSON, toMarkdown } from 'docsluice';

const doc = await extract(bytes, { filename: 'q3.xlsx' });
console.log(toMarkdown(doc));
console.log(toJSON(doc, { stable: true }));
```

For formats with an incremental reader, consume blocks as they arrive and await
the final document when iteration completes:

```ts
import { extractStream } from 'docsluice';

const stream = extractStream(file.stream(), { filename: 'records.csv' });
for await (const block of stream) render(block);
const streamedDocument = await stream.result;
```

See [streaming extraction](docs/streaming.md) for reader coverage, backpressure
and cancellation behavior.

One call gives text, Markdown, tables, page/slide/sheet locations and metadata from office, PDF, web, email and archive files. `toJSON` uses stable model field order; `stable: true` sets the extraction duration to zero for snapshots and golden files. Raw child bytes are omitted unless `bytes: 'base64'` is requested. Limits are on by default, so it is safe on files from strangers. No native code: it runs in Node.js 20+, Bun, Deno, browsers and edge workers.

> **Status: pre-alpha.** Nothing is published yet. See the [roadmap board](https://github.com/users/sanjay3290/projects/3) and [milestones](https://github.com/sanjay3290/docsluice/milestones).

## Docs

- [Product requirements](docs/prd.md)
- [Architecture](docs/architecture.md)
- [Decisions (ADRs)](docs/adr/)
- [Testing](docs/testing.md)
- [Streaming extraction](docs/streaming.md)
- [Contributing](CONTRIBUTING.md) · [Agents](AGENTS.md) · [Security](SECURITY.md)

## Working on it

Issues are written so an agent can finish each one end to end. See [AGENTS.md](AGENTS.md). In Claude Code: `/work-issue <n>` for one issue, `/work-board` to work every ready issue in order.

## Licence

[MIT](LICENSE)
