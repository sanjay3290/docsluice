import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const buildDir = globalThis.process.env.DOCSLUICE_FUZZ_BUILD_DIR;
const modulePath = (path) => pathToFileURL(resolve(buildDir, path)).href;
const [{ Budget }, { DEFAULT_LIMITS }, { openZip }] = await Promise.all([
  import(modulePath('src/core/budget.js')),
  import(modulePath('src/core/limits.js')),
  import(modulePath('src/zip/index.js')),
]);

/** Strict variant of the existing ZIP target: only documented parser errors are expected. */
export async function fuzzZipStrict(bytes) {
  if (bytes.byteLength > 1_000_000) return;
  const budget = new Budget(
    {
      ...DEFAULT_LIMITS,
      compressionRatio: 20,
      compressionRatioMinBytes: 1_024,
      totalUncompressedBytes: 2_000_000,
      zipEntries: 100,
      timeMs: 1_000,
    },
    { onLimit: 'truncate' },
  );
  try {
    const archive = openZip(bytes, budget);
    for (const entry of archive.entries) {
      budget.tick();
      await archive.read(entry);
    }
  } catch (error) {
    const { DocsluiceError } = await import(modulePath('src/core/errors.js'));
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}
