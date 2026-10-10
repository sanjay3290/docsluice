# docsluice

Safe, structured document extraction for every JavaScript runtime.

```ts
import { extract, toJSON, toMarkdown } from 'docsluice';

const doc = await extract(bytes, { filename: 'q3.xlsx' });
console.log(toMarkdown(doc));
console.log(toJSON(doc, { stable: true }));
```

To handle blocks as they are produced, and stop early:

```ts
import { extractStream } from 'docsluice';

const stream = extractStream(bytes, { filename: 'large.csv' });
for await (const block of stream) {
  if (block.kind === 'table') handle(block);
}
const doc = await stream.result; // metadata, warnings and every block, as extract() returns them
```

One call gives text, Markdown, tables, page/slide/sheet locations and metadata from office, PDF, web, email and archive files. `toJSON` uses stable model field order; `stable: true` sets the extraction duration to zero for snapshots and golden files. Raw child bytes are omitted unless `bytes: 'base64'` is requested. Limits are on by default, so it is safe on files from strangers. No native code: it runs in Node.js 20+, Bun, Deno, browsers and edge workers.

> **Status: pre-alpha.** Nothing is published yet. See the [roadmap board](https://github.com/users/sanjay3290/projects/3) and [milestones](https://github.com/sanjay3290/docsluice/milestones).

## Docs

Start with the [docs home](docs/index.md): [quick start](docs/quickstart.md), [security model](docs/security.md), [limits](docs/limits.md), [recipes](docs/recipes/index.md) and the [format pages](docs/formats/support-matrix.md). `npm run docs:site` builds them as a static site in `site/`, with the API reference from TSDoc ([ADR 0013](docs/adr/0013-documentation-site.md)).

- [Product requirements](docs/prd.md)
- [Architecture](docs/architecture.md)
- [Decisions (ADRs)](docs/adr/)
- [Testing](docs/testing.md)
- [Contributing](CONTRIBUTING.md) · [Agents](AGENTS.md) · [Security](SECURITY.md)

## Working on it

Issues are written so an agent can finish each one end to end. See [AGENTS.md](AGENTS.md). In Claude Code: `/work-issue <n>` for one issue, `/work-board` to work every ready issue in order.

## Licence

[MIT](LICENSE)
