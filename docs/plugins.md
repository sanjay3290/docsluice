# Format plugins

Format plugins let an application add a reader without changing docsluice's
built-in readers. A plugin receives the same `ReadContext` as a built-in reader,
including the shared budget, warnings, output builder, and child-extraction
function.

## A complete example

This example adds a small `note` format whose files begin with the four ASCII
bytes `NOTE`. The reader checks the remaining bytes through the shared budget
and emits a paragraph through `ctx.out`:

```ts
import { createRegistry, extract, READER_CONTRACT_VERSION } from 'docsluice';
import type { FormatPlugin } from 'docsluice';

const notePlugin: FormatPlugin = {
  id: 'note',
  mimeTypes: ['application/x-note'],
  contract: READER_CONTRACT_VERSION,
  detect(bytes) {
    return bytes[0] === 0x4e && bytes[1] === 0x4f && bytes[2] === 0x54 && bytes[3] === 0x45
      ? 0.99
      : 0;
  },
  async read(ctx) {
    for (let index = 0; index < ctx.bytes.length; index += 1) ctx.budget.tick();
    const body = new TextDecoder().decode(ctx.bytes.subarray(4));
    ctx.out.paragraph(body);
  },
};

const registry = createRegistry();
registry.registerFormat(notePlugin);

const document = await extract(
  new Uint8Array([0x4e, 0x4f, 0x54, 0x45, 0x48, 0x65, 0x6c, 0x6c, 0x6f]),
  { registry },
);
```

`document.format` is `note`, its MIME type is `application/x-note`, and its text
is `Hello`. Plugins can use exported safe helpers such as `openZip` and
`parseXml` when they need to read those formats. Do not use unbounded work or
untrusted file values as keys in ordinary objects.

## Registry and detection behavior

`createRegistry()` creates an isolated registry with the lazy built-in readers.
Registering a plugin on it affects calls that pass that registry in
`extract(input, { registry })`; other registries and the default registry are
unchanged. `registerFormat(plugin)` is a convenience for registering on the
shared default registry. Registrations are unique within one registry.

Built-in content detection gets first choice. Plugins are probed when built-in
detection is uncertain (confidence below `0.8`). MIME and filename-extension
hints can make a plugin eligible in that case. A plugin probe must return a
finite confidence from `0` to `1`; the best plugin must exceed `0.5` and, without
a matching hint, must score higher than the built-in result. A tie between the
best plugins leaves the built-in result in place and adds a `FORMAT_MISMATCH`
warning. Confident built-in content always wins over plugin hints, and
docsluice adds a `FORMAT_MISMATCH` warning
when a registered plugin hint disagrees with that content. MIME hints are
case-insensitive. For extension matching, the final filename suffix must match
the plugin `id`, such as `report.note` for `id: 'note'`.

An explicit `format` option bypasses detection and selects that registry entry.
If the selected plugin accepts several MIME types, a matching `mimeType` option
determines the result MIME; otherwise the first registered MIME type is used.

## Contract and errors

`READER_CONTRACT_VERSION` is currently `1.0.0`. Set the plugin's `contract` to
the version it was built against. The version must be valid semver; a different
major version throws `PluginContractError` with code `PLUGIN_INCOMPATIBLE`.
Invalid descriptors and invalid probe results fail with generic errors that do
not quote plugin-provided values.

If a plugin reader throws an ordinary error, extraction raises
`CorruptFileError` and preserves the original error as `cause`. The public
error message does not include that cause's message. docsluice structural
errors such as `LimitExceededError`, `StrictModeError`, `TimeoutError`, and
`AbortError` keep their original codes so callers can handle limits,
cancellation, and strict mode consistently for built-in and plugin readers.
Plugin readers should throw only when they cannot produce a useful result;
when part of a file can be read, emit it and add an `UNREADABLE_PART` warning
instead.
