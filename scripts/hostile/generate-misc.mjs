import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// A Windows executable header behind a .pdf name: detection must trust bytes, not the name.
const misc = new URL('../../hostile/misc/', import.meta.url);
await mkdir(misc, { recursive: true });
await writeFile(new URL('wrong-executable.pdf', misc), new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]));
