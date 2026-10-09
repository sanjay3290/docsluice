# OLE Compound File (CFB)

`packages/docsluice/src/ole/index.ts` exposes a synchronous, low-level reader for the Microsoft Compound File Binary format. `openCfb(bytes, budget)` returns directory entries and a `read(path)` method for stream data; it does not interpret DOC, XLS, PPT, or MSG stream contents.

Format detection indexes a CFB once and classifies legacy Word, Excel, PowerPoint and Outlook files from exact root stream names (`WordDocument`, `Workbook`/`Book`, `PowerPoint Document` and `__properties_version1.0`). Nested streams do not establish a document kind. Conflicting root identities remain generic `ole`. A root stream named `EncryptedPackage` stops detection with `EncryptedError`; nested streams with that name do not, and the detector does not read or decrypt the stream.

The reader accepts version 3 files with 512-byte sectors and version 4 files with 4096-byte sectors. It follows header and chained DIFAT/FAT allocation, MiniFAT allocation, root mini-stream data, and directory red-black links iteratively. It checks every sector chain for repeated or out-of-file sector IDs and charges stream bytes to the caller's shared `Budget` as they are returned. A stream's reported size is bounded by the sectors reachable through its allocation chain, so file-provided sizes never control an allocation.

Before allocating directory metadata, the reader charges the archive's physical directory slots (excluding the root slot) against the shared `zipEntries` allowance. This intentionally conservative count includes unused slots, shares the extraction allowance with ZIP archives and other CFB files, and returns a root-only archive when the allowance truncates.

Directory paths use `/` between storage names. Stream lookup is exact and case-sensitive. Directory entries use a `Map` keyed by those paths internally; duplicate paths make the file invalid. Callers should treat entry names as untrusted display data.

The implementation follows Microsoft's public [MS-CFB specification](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/53989ce4-7b05-4f8d-829b-d08d6148375b). It intentionally does not add document-format interpretation or change the public document model.
