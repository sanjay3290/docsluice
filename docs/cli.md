# Command line (`docsluice`)

The package installs a `docsluice` command (`bin` → `dist/node/cli.js`, built from `src/node/cli/index.ts`). It accepts file paths, glob patterns, and `-` for stdin (PRD section 18):

```sh
npx docsluice report.pdf                       # Markdown to stdout
npx docsluice report.pdf --format text
npx docsluice data.xlsx --format json > out.json
npx docsluice mail.eml --children list
cat file.docx | npx docsluice - --format markdown
npx docsluice "inbox/**/*.eml" --out-dir ./extracted
npx docsluice detect unknown.bin
```

The output defaults to Markdown. `--format` accepts `markdown`, `text`, or `json`; `detect <input>` (or `--detect <input>`) prints detection data as JSON without running a reader. Multiple JSON outputs are a JSON array. `--children` accepts `extract`, `list`, or `skip`; `--no-metadata` omits metadata; `--password-env NAME` reads a password from that environment variable. A plain `--password` value is not accepted. Stdin may be specified once.

Document content is written to stdout. Warnings are one line each on stderr in the form `docsluice: CODE: message`. Exit status is 0 for success, 1 for an error, and 2 for successful extraction with warnings when `--strict-exit` is set. `--out-dir` writes one file per input and leaves stdout empty. Names use a sanitized basename and the selected renderer extension (`.md`, `.txt`, or `.json`); collisions are given numeric suffixes, and existing files are never overwritten.

Every current core limit has a numeric CLI flag. Defaults come from `DEFAULT_LIMITS`:

| Limit | Flag |
| --- | --- |
| `inputBytes` | `--max-bytes` |
| `totalUncompressedBytes` | `--max-total-uncompressed-bytes` |
| `compressionRatio` | `--max-compression-ratio` |
| `compressionRatioMinBytes` | `--max-compression-ratio-min-bytes` |
| `zipEntries` | `--max-zip-entries` |
| `childDepth` | `--max-child-depth` |
| `xmlDepth` | `--max-xml-depth` |
| `blockDepth` | `--max-block-depth` |
| `outputChars` | `--max-output-chars` |
| `cells` | `--max-cells` |
| `pdfPages` | `--max-pdf-pages` |
| `pdfFonts` | `--max-pdf-fonts` |
| `timeMs` | `--timeout` |

Glob expansion is bounded before any document extraction begins. One CLI invocation shares a budget across all glob patterns: at most 50,000 yielded or visited filesystem entries, at most 50,000 fallback traversal states, at most 1,000 matched files, and the resolved core `timeMs` deadline (`--timeout`, 60 seconds by default). Node's native `fs/promises.glob` path counts yielded paths and enforces the same match and elapsed-time bounds; the Node 20 fallback supports `*`, `?`, and `**` path segments, streams directory entries instead of materializing each directory, counts entries and queued traversal states, and skips symlinked directories. A zero timeout rejects glob expansion immediately, consistent with the core budget. These fixed internal expansion caps do not add CLI flags.

The Node 20 fallback matches each path segment with iterative dynamic programming, not a regular expression built from the user-supplied pattern. This avoids backtracking blowups on hostile patterns such as repeated `*a` tokens followed by a non-matching suffix. A spawned regression applies such a pattern to a maximum-length filename with a hard process timeout.

## Tests

```sh
npm test -- --run test/node/cli.test.ts        # source, bundled into a temporary CLI
node --test packages/docsluice/test-dist/smoke.test.mjs   # the built bin, every PRD example
```

The built-package smoke test runs every PRD section 18 example through `dist/node/cli.js` on each supported Node version, including a run through a `bin` symlink as npm installs it. Until the PDF reader is merged (#45), the `report.pdf` examples run with a DOCX.
