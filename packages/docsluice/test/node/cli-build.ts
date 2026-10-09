import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(new URL(import.meta.url))), '../..');
const repositoryRoot = resolve(packageRoot, '../..');

export interface BuiltCli {
  directory: string;
  executable: string;
  globExecutable: string;
  cleanup: () => Promise<void>;
}

/** Bundle only the CLI for spawn tests; the package's shared build entry list stays untouched. */
export async function buildCli(): Promise<BuiltCli> {
  // Keep the temporary bundle under the package so ESM can resolve dev/runtime deps upward.
  const directory = await mkdtemp(join(packageRoot, '.cli-test-'));
  const entry = join(packageRoot, 'src/node/cli/index.ts');
  const globEntry = join(packageRoot, 'src/node/cli/glob.ts');
  const tsdown = join(repositoryRoot, 'node_modules/.bin/tsdown');
  try {
    await execFileAsync(
      tsdown,
      [
        '--no-config',
        entry,
        globEntry,
        '--format',
        'esm',
        '--out-dir',
        directory,
        '--target',
        'es2022',
        '--platform',
        'node',
      ],
      { cwd: packageRoot, timeout: 30_000 },
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const files = await readdir(directory);
  const executable = files.find((file) => file === 'index.mjs' || file === 'index.js');
  const globExecutable = files.find((file) => file === 'glob.mjs' || file === 'glob.js');
  if (!executable || !globExecutable) {
    await rm(directory, { recursive: true, force: true });
    throw new Error('The temporary CLI build did not produce executable entries.');
  }
  return {
    directory,
    executable: join(directory, executable),
    globExecutable: join(directory, globExecutable),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
