import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Hostile JSON inputs: prototype-named keys and nesting far past the block depth.
const json = new URL('../../hostile/json/', import.meta.url);
await mkdir(json, { recursive: true });
await writeFile(
  new URL('proto-keys.json', json),
  '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":"p"}\n',
);
await writeFile(new URL('deep-100000.json', json), `${'['.repeat(100_000)}1${']'.repeat(100_000)}\n`);
