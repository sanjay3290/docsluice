# YAML

The YAML reader (`docsluice/yaml`) reads YAML without a YAML parser. Block mappings and sequences become `path: value` paragraphs in the [JSON](json.md) reader's path style (`$.survey.sites[0].id: north-inlet`), each with its path in `loc.path`. Inputs up to 64 KiB also keep their whole source as a `yaml` code block.

- **Detection**: YAML has no reliable signature: loose text (plain, Markdown-like or CSV-like) is read as YAML when its name (`.yaml`, `.yml`) or MIME type says so.
- **Values**: plain, single- and double-quoted scalars (quotes removed, `''` and `\"` unescaped), trailing ` # comments` removed. Flow collections (`[a, b]`, `{a: 1}`) are one value as written. Literal (`|`) block scalars keep their lines; folded (`>`) ones are joined with spaces.
- **Documents**: `---` and `...` start a new document; its paths start again at `$`.
- **Safety**: keys are strings in arrays, never object keys (SEC-6). Anchors (`&a`), aliases (`*a`), merge keys (`<<`) and tags are text and are never expanded, so an alias bomb stays as small as its source. Nesting deeper than `blockDepth` keeps the last path, with one `DEPTH_LIMIT` warning; a long `- - - …` chain is then one value. Scanning is line by line with no regular expressions over the content.

Not supported (out of scope for issue #68): full YAML 1.2, flow collections spread over several lines, multi-line plain scalars, complex keys (`? key`) and tag resolution.

`scripts/hostile/generate-text-families.mjs` writes `hostile/yaml` (alias bomb, deep nesting, a dash chain and a block-scalar flood).
