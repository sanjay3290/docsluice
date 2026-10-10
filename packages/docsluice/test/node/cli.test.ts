/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { buildCli, type BuiltCli } from './cli-build.js';
import { expandGlob, expandGlobFallback, expandGlobs } from '../../src/node/cli/glob.js';

const fixture = new URL('../../../../corpus/doc/doc-legacy.doc', import.meta.url);
let cli: BuiltCli;

beforeAll(async () => {
  cli = await buildCli();
});

afterAll(async () => {
  await cli?.cleanup();
});

function run(args: string[], options: { input?: Uint8Array; cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(process.execPath, [cli.executable, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    input: options.input,
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('docsluice CLI', () => {
  it('lists all renderer, extraction, and generated limit flags without a password value flag', () => {
    const result = run(['--help']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    for (const flag of [
      '--format',
      '--children',
      '--out-dir',
      '--strict-exit',
      '--no-metadata',
      '--password-env',
      '--detect',
      '--help',
      '--max-bytes',
      '--timeout',
    ])
      expect(result.stdout).toContain(flag);
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      const flag =
        key === 'inputBytes'
          ? '--max-bytes'
          : key === 'timeMs'
            ? '--timeout'
            : `--max-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      expect(result.stdout).toContain(flag);
    }
    expect(result.stdout).not.toContain('--password ');

    const limitArgs = Object.entries(DEFAULT_LIMITS).flatMap(([key, value]) => {
      const flag =
        key === 'inputBytes'
          ? '--max-bytes'
          : key === 'timeMs'
            ? '--timeout'
            : `--max-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      return [flag, String(value)];
    });
    expect(run([fixture.pathname, ...limitArgs]).status).toBe(0);
  });

  it('extracts a registered legacy DOC file and renders Markdown to stdout only', () => {
    const result = run([fixture.pathname, '--format', 'markdown']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('# Legacy Word fixture');
    expect(result.stderr).toBe('');

    const json = run([fixture.pathname, '--format', 'json', '--no-metadata']);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ format: 'doc', metadata: {} });

    const multiple = run([fixture.pathname, fixture.pathname, '--format', 'json']);
    expect(multiple.status, multiple.stderr).toBe(0);
    expect(JSON.parse(multiple.stdout)).toHaveLength(2);
  });

  it('accepts stdin and detects a file without invoking the reader', async () => {
    const input = new Uint8Array(await readFile(fixture));
    const streamed = run(['-', '--format', 'text'], { input });
    expect(streamed.status, streamed.stderr).toBe(0);
    expect(streamed.stdout).toContain('Legacy Word fixture');
    expect(streamed.stderr).toBe('');

    const detected = run(['detect', fixture.pathname]);
    expect(detected.status, detected.stderr).toBe(0);
    expect(JSON.parse(detected.stdout)).toMatchObject({ format: 'doc', mimeType: 'application/msword' });
  });

  it('writes sanitized, collision-safe output names for globbed inputs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'docsluice-cli-output-'));
    try {
      await Promise.all(
        ['a', 'b'].map(async (child) => {
          const inputDirectory = join(directory, child);
          await import('node:fs/promises').then(({ mkdir }) => mkdir(inputDirectory));
          await copyFile(fixture, join(inputDirectory, 'report.doc'));
        }),
      );
      const output = join(directory, 'out');
      await mkdir(output);
      await writeFile(join(output, 'report.md'), 'keep existing file');
      const result = run(['**/report.doc', '--out-dir', output], { cwd: directory });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      const names = (await readdir(output)).sort();
      expect(names).toEqual(['report-2.md', 'report-3.md', 'report.md']);
      expect(await readFile(join(output, 'report.md'), 'utf8')).toBe('keep existing file');
      for (const name of names.filter((item) => item !== 'report.md'))
        expect(await readFile(join(output, name), 'utf8')).toContain('# Legacy Word fixture');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the documented simple glob fallback when native fs.glob is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'docsluice-cli-glob-'));
    try {
      await mkdir(join(directory, 'inbox', 'nested'), { recursive: true });
      await writeFile(join(directory, 'inbox', 'one.eml'), 'one');
      await writeFile(join(directory, 'inbox', 'a1.eml'), 'wildcard');
      await writeFile(join(directory, 'inbox', 'nested', 'two.eml'), 'two');
      expect(await expandGlobFallback('inbox/**/*.eml', directory)).toEqual(
        [
          join(directory, 'inbox', 'nested', 'two.eml'),
          join(directory, 'inbox', 'one.eml'),
          join(directory, 'inbox', 'a1.eml'),
        ].sort(),
      );
      expect(await expandGlobFallback('inbox/a?.eml', directory)).toEqual([
        join(directory, 'inbox', 'a1.eml'),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('matches hostile glob segments without exponential regex backtracking', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'docsluice-cli-glob-hostile-'));
    try {
      await writeFile(join(directory, 'a'.repeat(255)), 'fixture');
      const pattern = `*a`.repeat(30) + 'b';
      const moduleUrl = pathToFileURL(cli.globExecutable).href;
      const script = `
        import { expandGlobFallback } from ${JSON.stringify(moduleUrl)};
        const [pattern, cwd] = JSON.parse(process.argv[1]);
        const matches = await expandGlobFallback(pattern, cwd, { timeMs: 60_000 });
        if (matches.length !== 0) process.exitCode = 1;
      `;
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', script, JSON.stringify([pattern, directory])],
        {
          encoding: 'utf8',
          timeout: 2_000,
        },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bounds native glob matches, fallback entries, and fallback queued states', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'docsluice-cli-glob-budget-'));
    try {
      await mkdir(join(directory, 'a', 'nested'), { recursive: true });
      await mkdir(join(directory, 'b', 'nested'), { recursive: true });
      await Promise.all(
        ['a/one.doc', 'a/nested/two.doc', 'b/nested/three.doc'].map((name) =>
          writeFile(join(directory, name), 'fixture'),
        ),
      );

      await expect(
        expandGlob('**/*.doc', directory, { maxEntries: 2, maxMatches: 10, timeMs: 1_000 }),
      ).rejects.toThrow(/glob expansion exceeded maxEntries/i);
      await expect(
        expandGlobFallback('**/*.doc', directory, { maxEntries: 2, maxMatches: 10, timeMs: 1_000 }),
      ).rejects.toThrow(/glob expansion exceeded maxEntries.*queuing traversal states/i);
      await expect(
        expandGlobFallback('a/*.missing', directory, { maxEntries: 1, maxMatches: 10, timeMs: 1_000 }),
      ).rejects.toThrow(/glob expansion exceeded maxEntries/i);
      await expect(
        expandGlobFallback('**/*.doc', directory, { maxEntries: 100, maxMatches: 2, timeMs: 1_000 }),
      ).rejects.toThrow(/glob expansion exceeded maxMatches/i);
      await expect(
        expandGlobFallback('**/*.doc', directory, { maxEntries: 100, maxMatches: 10, timeMs: 0 }),
      ).rejects.toThrow(/glob expansion exceeded timeMs/i);
      await expect(
        expandGlobs(['**/*.doc', '**/*.doc'], directory, {
          maxEntries: 100,
          maxMatches: 5,
          timeMs: 1_000,
        }),
      ).rejects.toThrow(/glob expansion exceeded maxMatches/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns 2 only for warning-bearing success with --strict-exit, and 1 for errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'docsluice-cli-errors-'));
    try {
      const mismatch = join(directory, 'mismatch.txt');
      await copyFile(fixture, mismatch);
      const warning = run([mismatch, '--strict-exit']);
      expect(warning.status).toBe(2);
      expect(warning.stdout).toContain('# Legacy Word fixture');
      expect(warning.stderr).toMatch(/^docsluice: FORMAT_MISMATCH: .+\n$/);

      const unknown = join(directory, 'unknown.bin');
      await writeFile(unknown, Uint8Array.of(0x00, 0x01, 0x02));
      const error = run([unknown]);
      expect(error.status).toBe(1);
      expect(error.stdout).toBe('');
      expect(error.stderr).toMatch(/^docsluice: UNSUPPORTED_FORMAT: .+\n$/);
      expect(run([fixture.pathname, '--password', 'secret']).status).toBe(1);
      const passwordValue = 'do-not-print-cli-test-password';
      const passwordName = 'DOCSLUICE_CLI_TEST_PASSWORD_9F51';
      const passwordSuccess = run([fixture.pathname, '--password-env', passwordName], {
        env: { [passwordName]: passwordValue },
      });
      expect(passwordSuccess.status, passwordSuccess.stderr).toBe(0);
      expect(passwordSuccess.stdout).toContain('Legacy Word fixture');
      expect(passwordSuccess.stdout).not.toContain(passwordValue);
      expect(passwordSuccess.stderr).not.toContain(passwordValue);

      const missingPassword = run([fixture.pathname, '--password-env', 'DOCSLUICE_CLI_TEST_UNSET_9F51']);
      expect(missingPassword.status).toBe(1);
      expect(missingPassword.stdout).toBe('');
      expect(missingPassword.stderr).toContain(
        'Environment variable DOCSLUICE_CLI_TEST_UNSET_9F51 is not set.',
      );
      expect(missingPassword.stderr).not.toContain('Legacy Word fixture');
      const emptyLimit = run([fixture.pathname, '--max-bytes=']);
      expect(emptyLimit.status).toBe(1);
      expect(emptyLimit.stderr).toContain('--max-bytes must be a finite number >= 0.');
      const malformedLimit = run([fixture.pathname, '--max-bytes=12bytes']);
      expect(malformedLimit.status).toBe(1);
      expect(malformedLimit.stdout).toBe('');
      expect(malformedLimit.stderr).toContain('--max-bytes must be a finite number >= 0.');
      expect(run([fixture.pathname, '--out-dir=']).stderr).toContain('--out-dir must not be empty.');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('enforces --max-bytes for both file and stdin input before rendering content', async () => {
    const input = new Uint8Array(await readFile(fixture));
    const file = run([fixture.pathname, '--max-bytes', '1']);
    expect(file.status).toBe(1);
    expect(file.stdout).toBe('');
    expect(file.stderr).toMatch(/^docsluice: LIMIT_EXCEEDED: Limit "inputBytes" \(1\) was exceeded\.\n$/);

    const stdin = run(['-', '--max-bytes', '1'], { input });
    expect(stdin.status).toBe(1);
    expect(stdin.stdout).toBe('');
    expect(stdin.stderr).toMatch(/^docsluice: LIMIT_EXCEEDED: Limit "inputBytes" \(1\) was exceeded\.\n$/);
  });

  it('passes a zero core timeout to glob expansion as an immediate deadline', () => {
    const noGlobTime = run(['*.doc', '--timeout', '0'], { cwd: dirname(fileURLToPath(fixture)) });
    expect(noGlobTime.status).toBe(1);
    expect(noGlobTime.stdout).toBe('');
    expect(noGlobTime.stderr).toContain('Glob expansion exceeded timeMs (0).');
  });
});
