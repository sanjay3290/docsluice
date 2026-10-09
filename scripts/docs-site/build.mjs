import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const toolsRoot = process.env.DOCS_SITE_TOOLS;
if (!toolsRoot)
  throw new Error('Set DOCS_SITE_TOOLS to the node_modules directory containing VitePress and TypeDoc.');

function run(script, args, base = toolsRoot) {
  const result = spawnSync(process.execPath, [resolve(base, script), ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('scripts/docs-site/generate-limits.mjs', ['--check'], process.cwd());
run('vitepress/bin/vitepress.js', ['build', 'docs']);
run('typedoc/bin/typedoc', [
  '--entryPoints',
  'packages/docsluice/src/index.ts',
  '--tsconfig',
  'packages/docsluice/tsconfig.json',
  '--out',
  'docs/.vitepress/dist/api',
  '--name',
  'docsluice API',
  '--readme',
  'none',
  '--excludeInternal',
]);
await access('docs/.vitepress/dist/index.html');
await access('docs/.vitepress/dist/api/index.html');
