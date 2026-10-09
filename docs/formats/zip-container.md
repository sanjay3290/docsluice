# ZIP containers

The ZIP reader treats a plain archive as a container. It emits no blocks of its own and processes entries in the safe ZIP index's central-directory order. Regular entries are delegated to `ReadContext.extractChild()`, so nested readers use the same shared byte, time, entry, and depth budgets.

Directory entries whose sanitized names end in `/`, and common macOS/Windows metadata (`__MACOSX`, `.DS_Store`, `Thumbs.db`) are listed with `status: "skipped"`. Path names come from `openZip()`, which cleans traversal segments before the reader uses them. The reader never writes archive paths to disk. Since `ZipEntry` does not expose external file attributes, directories without a trailing slash are not identified as directories here.

`children: "extract"` reads each supported regular entry and delegates it in order. `children: "list"` records entry names and declared sizes without reading payloads. `children: "skip"` omits ordinary child entries without reading payloads. Directory and OS-junk entries remain listed as skipped in all three modes. Encrypted entries are always listed as failed with code `ENCRYPTED`, and set `features.isEncrypted`; decryption is not attempted. Other entries that the safe ZIP index marks unreadable are listed as failed with `UNREADABLE_PART`.

The safe ZIP reader charges actual produced bytes to the shared budget and checks compression ratio while inflating. A truncated shared budget stops further child reads. When another extraction level would exceed `childDepth`, files are listed without opening their payloads, and the shared budget emits `DEPTH_LIMIT`.

The reader detects a child whose complete bytes exactly match the current ZIP bytes and marks it failed with `CORRUPT_FILE`. The current `ReadContext` has no ancestor-archive identity set, so this is direct self-identical-child detection rather than general cycle detection across all ancestors.

This module is prepared for the reader registry but is not yet wired into public `extract()` dispatch. The mixed archive under `corpus/zip/` is an input candidate only; no extraction output goldens are included until the pipeline integration is available.
