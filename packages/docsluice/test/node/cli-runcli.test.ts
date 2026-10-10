/// <reference types="node" />

// In-process tests of `runCli` (the built binary is covered by cli.test.ts). They count toward
// coverage, which a spawned process does not (QA-5).
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/node/cli/index.js';

const corpus = (path: string) => fileURLToPath(new URL(`../../../../corpus/${path}`, import.meta.url));
const hostile = (path: string) => fileURLToPath(new URL(`../../../../hostile/${path}`, import.meta.url));

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const code = await runCli(args);
    return { code, stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('runCli', () => {
  it('prints help with every limit flag', async () => {
    const { code, stdout } = await cli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: docsluice <input...> [options]');
    expect(stdout).toContain('--max-cells <number>');
  });

  it('renders Markdown, text and JSON', async () => {
    const markdown = await cli([corpus('markdown/constructs.md')]);
    expect(markdown.code).toBe(0);
    expect(markdown.stdout.length).toBeGreaterThan(10);
    const text = await cli([corpus('csv/rfc4180-crlf.csv'), '--format', 'text']);
    expect(text.code).toBe(0);
    const json = await cli([
      corpus('csv/rfc4180-crlf.csv'),
      '--format',
      'json',
      '--no-metadata',
      '--max-cells',
      '1000',
    ]);
    expect((JSON.parse(json.stdout) as { format: string }).format).toBe('csv');
  });

  it('separates several outputs, and wraps several JSON outputs in one array', async () => {
    const two = await cli([
      corpus('csv/rfc4180-crlf.csv'),
      corpus('markdown/constructs.md'),
      '--format',
      'text',
    ]);
    expect(two.code).toBe(0);
    const json = await cli([
      corpus('csv/rfc4180-crlf.csv'),
      corpus('markdown/constructs.md'),
      '--format',
      'json',
    ]);
    expect((JSON.parse(json.stdout) as unknown[]).length).toBe(2);
    const detected = await cli(['detect', corpus('csv/rfc4180-crlf.csv'), corpus('markdown/constructs.md')]);
    expect((JSON.parse(detected.stdout) as Array<{ format: string }>).map((result) => result.format)).toEqual(
      ['csv', 'markdown'],
    );
    const one = await cli(['--detect', corpus('csv/rfc4180-crlf.csv')]);
    expect((JSON.parse(one.stdout) as { format: string }).format).toBe('csv');
  });

  it('writes one safely named file per input to --out-dir, without overwriting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'docsluice-cli-'));
    temporary.push(directory);
    const input = corpus('csv/rfc4180-crlf.csv');
    expect((await cli([input, input, '--out-dir', directory, '--format', 'json'])).code).toBe(0);
    expect((await cli([input, '--out-dir', directory, '--format', 'json'])).code).toBe(0);
    expect((await readdir(directory)).sort()).toEqual([
      'rfc4180-crlf-2.json',
      'rfc4180-crlf-3.json',
      'rfc4180-crlf.json',
    ]);
    expect(JSON.parse(await readFile(join(directory, 'rfc4180-crlf.json'), 'utf8'))).toMatchObject({
      format: 'csv',
    });
  });

  it('reports warnings on stderr and exits 2 with --strict-exit', async () => {
    const input = hostile('docx/image-and-revision-oddities.docx');
    const relaxed = await cli([input]);
    expect(relaxed.code).toBe(0);
    expect(relaxed.stderr).toContain('docsluice: HIDDEN_CONTENT:');
    expect((await cli([input, '--strict-exit'])).code).toBe(2);
  });

  it.each([
    [['--format', 'pdf', 'x'], '--format must be markdown, text, or json.'],
    [['--children', 'all', 'x'], '--children must be extract, list, or skip.'],
    [['--out-dir', ' ', 'x'], '--out-dir must not be empty.'],
    [['--password-env', ' ', 'x'], '--password-env must name an environment variable.'],
    [['--max-cells=-1', 'x'], '--max-cells must be a finite number >= 0.'],
    [['--max-cells', ' ', 'x'], '--max-cells must be a finite number >= 0.'],
    [[], 'Provide one or more input paths, or - for stdin.'],
    [['-', '-'], 'Stdin can only be used once per command.'],
    [['detect', 'x', '--out-dir', 'out'], '--out-dir cannot be used with detection output.'],
    [
      ['--password-env', 'DOCSLUICE_TEST_UNSET_VARIABLE', 'x'],
      'Environment variable DOCSLUICE_TEST_UNSET_VARIABLE is not set.',
    ],
    [['no-such-dir/*.nothing'], 'No files matched no-such-dir/*.nothing.'],
  ])('rejects %j', async (args, message) => {
    const { code, stderr } = await cli(args);
    expect(code).toBe(1);
    expect(stderr).toContain(message);
  });

  it('closes an aggregate JSON array when a later input fails, and names the error code', async () => {
    const { code, stdout, stderr } = await cli([
      corpus('csv/rfc4180-crlf.csv'),
      hostile('docx/document-bomb.docx'),
      '--format',
      'json',
    ]);
    expect(code).toBe(1);
    expect(stdout.trimEnd().endsWith(']')).toBe(true);
    expect(stderr).toContain('docsluice: LIMIT_EXCEEDED: ');
  });

  it('reads a password from the named environment variable', async () => {
    process.env.DOCSLUICE_TEST_PASSWORD = 'secret';
    try {
      expect(
        (await cli([corpus('csv/rfc4180-crlf.csv'), '--password-env', 'DOCSLUICE_TEST_PASSWORD'])).code,
      ).toBe(0);
    } finally {
      delete process.env.DOCSLUICE_TEST_PASSWORD;
    }
  });
});
