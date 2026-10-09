# Document JSON contract

`DocsluiceDocument` is the versioned public shape returned by document extraction and serialized by `toJSON()`. The package ships its JSON Schema 2020-12 form at `docsluice/schema.json` for tools outside JavaScript. The schema is generated from exported types in `packages/docsluice/src/core/model.ts`; do not edit `packages/docsluice/schema.json` by hand.

The schema `$id` includes the package's major version (`.../schema/v0` for the current `0.x` release line). Changes that break the model require a major-version change, as described in [the PRD](prd.md#9-output-model). Unknown object properties are rejected because `toJSON()` serializes only the documented model fields. `format` remains an open string so plugins can use their own format ids.

`toJSON()` omits child bytes by default. When called with `{ bytes: 'base64' }`, it emits those bytes as base64 strings, which the schema describes with `contentEncoding: "base64"`.

The build and package test commands regenerate the schema from the model before running. `npm run schema:generate --workspace=packages/docsluice` can regenerate it directly. The schema tests compile it with Ajv's Draft 2020-12 implementation, validate the full-document model fixture in `corpus/model/`, and validate future document-level golden files under `corpus/`.
