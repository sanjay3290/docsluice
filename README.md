# docsluice

Safe, structured document extraction for every JavaScript runtime.

```ts
import { extract, toMarkdown } from 'docsluice';

const doc = await extract(bytes, { filename: 'q3.xlsx' });
console.log(toMarkdown(doc));
```

One call gives text, Markdown, tables, page/slide/sheet locations and metadata from office, PDF, web, email and archive files. Limits are on by default, so it is safe on files from strangers. No native code: it runs in Node.js 20+, Bun, Deno, browsers and edge workers.

> **Status: pre-alpha.** Nothing is published yet. See the [roadmap board](https://github.com/users/sanjay3290/projects/3) and [milestones](https://github.com/sanjay3290/docsluice/milestones).

## Docs

- [Product requirements](docs/prd.md)
- [Architecture](docs/architecture.md)
- [Decisions (ADRs)](docs/adr/)
- [Testing](docs/testing.md)
- [Contributing](CONTRIBUTING.md) · [Agents](AGENTS.md) · [Security](SECURITY.md)

## Licence

[MIT](LICENSE)
