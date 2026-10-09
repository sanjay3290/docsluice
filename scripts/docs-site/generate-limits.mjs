import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMITS } from '../../packages/docsluice/dist/index.js';
import { renderLimits } from './limits.mjs';

const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/site/reference/limits.md');
const desired = renderLimits(DEFAULT_LIMITS);
if (process.argv.includes('--check')) {
  const existing = await readFile(output, 'utf8').catch(() => '');
  if (existing !== desired) {
    console.error(
      'Generated limits page is stale; run node scripts/docs-site/generate-limits.mjs after building docsluice.',
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(output, desired);
}

export { renderLimits };
