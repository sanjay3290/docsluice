import { runRuntimeContract } from './cases.mjs';

async function readFixture(url) {
  if (globalThis.Deno) return globalThis.Deno.readFile(url);
  if (globalThis.Bun) return new Uint8Array(await globalThis.Bun.file(url).arrayBuffer());
  const { readFile } = await import('node:fs/promises');
  return new Uint8Array(await readFile(url));
}

const fixtures = {
  validZip: await readFixture(new globalThis.URL('../../../corpus/zip/hello.odt', import.meta.url)),
  traversalZip: await readFixture(
    new globalThis.URL('../../../hostile/zip/path-traversal.zip', import.meta.url),
  ),
  hostileXml: await readFixture(new globalThis.URL('../../../hostile/xml/xxe-file.xml', import.meta.url)),
};

await runRuntimeContract(fixtures);
globalThis.console.log('Built-package portable runtime contract passed.');
