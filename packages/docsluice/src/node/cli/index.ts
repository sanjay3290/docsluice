#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';
import { detect } from '../../detect/detect.js';
import { DEFAULT_LIMITS, resolveLimits } from '../../core/limits.js';
import type { Limits } from '../../core/limits.js';
import type { ExtractOptions } from '../../core/options.js';
import { toJSON } from '../../render/json.js';
import { toMarkdown } from '../../render/markdown.js';
import { toText } from '../../render/text.js';
import { extract, extractFile } from '../file.js';
import { expandGlobs, isGlobPattern } from './glob.js';

type OutputFormat = 'markdown' | 'text' | 'json';
type LimitKey = keyof Limits;
interface CliOptions {
  format: OutputFormat;
  children: 'extract' | 'list' | 'skip';
  outDir?: string;
  strictExit: boolean;
  metadata: boolean;
  passwordEnv?: string;
  detectOnly: boolean;
  limits: Partial<Limits>;
  inputs: string[];
  help: boolean;
}

const LIMIT_FLAGS: Record<LimitKey, string> = {
  inputBytes: 'max-bytes',
  totalUncompressedBytes: 'max-total-uncompressed-bytes',
  compressionRatio: 'max-compression-ratio',
  compressionRatioMinBytes: 'max-compression-ratio-min-bytes',
  zipEntries: 'max-zip-entries',
  childDepth: 'max-child-depth',
  xmlDepth: 'max-xml-depth',
  blockDepth: 'max-block-depth',
  outputChars: 'max-output-chars',
  cells: 'max-cells',
  pdfPages: 'max-pdf-pages',
  pdfFonts: 'max-pdf-fonts',
  timeMs: 'timeout',
};

const GENERAL_OPTIONS = {
  format: { type: 'string' },
  children: { type: 'string' },
  'out-dir': { type: 'string' },
  'strict-exit': { type: 'boolean' },
  'no-metadata': { type: 'boolean' },
  'password-env': { type: 'string' },
  detect: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

const OPTION_CONFIG: ParseArgsOptionsConfig = {
  ...GENERAL_OPTIONS,
  ...Object.fromEntries(Object.values(LIMIT_FLAGS).map((flag) => [flag, { type: 'string' as const }])),
};

function parseCli(args: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args,
    options: OPTION_CONFIG,
    allowPositionals: true,
    strict: true,
  });
  const format = (values.format ?? 'markdown') as string;
  if (format !== 'markdown' && format !== 'text' && format !== 'json')
    throw new TypeError('--format must be markdown, text, or json.');
  const children = (values.children ?? 'extract') as string;
  if (children !== 'extract' && children !== 'list' && children !== 'skip')
    throw new TypeError('--children must be extract, list, or skip.');
  if (typeof values['out-dir'] === 'string' && values['out-dir'].trim() === '')
    throw new TypeError('--out-dir must not be empty.');
  if (typeof values['password-env'] === 'string' && values['password-env'].trim() === '')
    throw new TypeError('--password-env must name an environment variable.');

  const limits: Partial<Limits> = {};
  for (const [key, flag] of Object.entries(LIMIT_FLAGS) as Array<[LimitKey, string]>) {
    const raw = values[flag];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') throw new TypeError(`--${flag} must be a finite number >= 0.`);
    if (raw.trim() === '') throw new TypeError(`--${flag} must be a finite number >= 0.`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`--${flag} must be a finite number >= 0.`);
    limits[key] = value;
  }
  resolveLimits(limits);

  const inputs = [...positionals];
  const detectOnly = values.detect === true || inputs[0] === 'detect';
  if (inputs[0] === 'detect') inputs.shift();
  if (values.help !== true && inputs.length === 0)
    throw new TypeError('Provide one or more input paths, or - for stdin.');
  if (values.help !== true && inputs.filter((input) => input === '-').length > 1)
    throw new TypeError('Stdin can only be used once per command.');
  if (detectOnly && values['out-dir']) throw new TypeError('--out-dir cannot be used with detection output.');

  return {
    format,
    children,
    ...(values['out-dir'] !== undefined ? { outDir: values['out-dir'] as string } : {}),
    strictExit: values['strict-exit'] === true,
    metadata: values['no-metadata'] !== true,
    ...(values['password-env'] !== undefined ? { passwordEnv: values['password-env'] as string } : {}),
    detectOnly,
    limits,
    inputs,
    help: values.help === true,
  };
}

function helpText(): string {
  const lines = [
    'Usage: docsluice <input...> [options]',
    '       docsluice detect <input...> [options]',
    '',
    'Inputs may be file paths, glob patterns, or - for stdin.',
    '',
    'Options:',
    '  --format <markdown|text|json>  Output format (default: markdown)',
    '  --children <extract|list|skip> How to handle embedded documents',
    '  --out-dir <directory>          Write one safely named output per input',
    '  --strict-exit                  Exit 2 after successful extraction with warnings',
    '  --no-metadata                  Omit metadata during extraction',
    '  --password-env <NAME>          Read a password from this environment variable',
    '  --detect                       Print detection details without extracting',
    '  -h, --help                     Show this help',
  ];
  for (const key of Object.keys(DEFAULT_LIMITS) as LimitKey[]) {
    const flag = LIMIT_FLAGS[key];
    lines.push(`  --${flag} <number>  Set ${key}`);
  }
  return `${lines.join('\n')}\n`;
}

function inputOptions(options: CliOptions): ExtractOptions {
  const password = options.passwordEnv === undefined ? undefined : process.env[options.passwordEnv];
  if (options.passwordEnv !== undefined && password === undefined)
    throw new TypeError(`Environment variable ${options.passwordEnv} is not set.`);
  return {
    limits: options.limits,
    children: options.children,
    metadata: options.metadata,
    ...(password !== undefined ? { password } : {}),
  };
}

async function expandInputs(inputs: string[], timeMs: number): Promise<string[]> {
  const patterns = inputs.filter(isGlobPattern);
  const groups = await expandGlobs(patterns, process.cwd(), { timeMs });
  let patternIndex = 0;
  const expanded: string[] = [];
  for (const input of inputs) {
    if (input === '-' || !isGlobPattern(input)) {
      expanded.push(input);
      continue;
    }
    const matches = groups[patternIndex++]!;
    if (matches.length === 0) throw new Error(`No files matched ${input}.`);
    expanded.push(...matches);
  }
  return expanded;
}

function render(document: Awaited<ReturnType<typeof extract>>, format: OutputFormat): string {
  if (format === 'text') return toText(document);
  if (format === 'json') return toJSON(document, { stable: true });
  return toMarkdown(document);
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

function warningLines(warnings: Awaited<ReturnType<typeof extract>>['warnings']): string {
  return warnings.map((warning) => `docsluice: ${warning.code}: ${singleLine(warning.message)}\n`).join('');
}

async function writeStdout(text: string): Promise<void> {
  if (process.stdout.write(text)) return;
  await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
}

function errorLine(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'ERROR';
  const message = error instanceof Error ? error.message : String(error);
  return `docsluice: ${code}: ${singleLine(message)}\n`;
}

function safeOutputName(input: string, format: OutputFormat, used: Set<string>): string {
  const original = input === '-' ? 'stdin' : basename(input);
  const extension = extname(original);
  const stem =
    (extension ? original.slice(0, -extension.length) : original)
      .normalize('NFKC')
      .replace(/[^\w.-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 120) || 'document';
  const suffix = format === 'markdown' ? '.md' : format === 'text' ? '.txt' : '.json';
  let name = `${stem}${suffix}`;
  let number = 2;
  while (used.has(name)) name = `${stem}-${number++}${suffix}`;
  used.add(name);
  return name;
}

async function writeOutput(
  directory: string,
  input: string,
  format: OutputFormat,
  content: string,
  used: Set<string>,
) {
  await mkdir(directory, { recursive: true });
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const name = safeOutputName(input, format, used);
    try {
      await writeFile(join(directory, name), content, { flag: 'wx' });
      return;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
      used.add(name);
    }
  }
  throw new Error(`Could not choose a free output name for ${basename(input)}.`);
}

async function detectInput(input: string, options: ExtractOptions) {
  const stream = input === '-' ? process.stdin : (await import('node:fs')).createReadStream(input);
  const webStream = (await import('node:stream')).Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  return detect(webStream, { ...options, ...(input === '-' ? {} : { filename: basename(input) }) });
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseCli(args);
    if (options.help) {
      process.stdout.write(helpText());
      return 0;
    }
    const limits = resolveLimits(options.limits);
    const effective = inputOptions(options);
    const inputs = await expandInputs(options.inputs, limits.timeMs);
    const usedNames = new Set<string>();
    let hadWarnings = false;
    let outputCount = 0;
    const aggregateJson =
      !options.outDir && (options.detectOnly || options.format === 'json') && inputs.length > 1;
    let aggregateStarted = false;

    try {
      for (const input of inputs) {
        let content: string;
        if (options.detectOnly) {
          content = JSON.stringify(await detectInput(input, effective), null, 2);
        } else {
          const document =
            input === '-' ? await extract(process.stdin, effective) : await extractFile(input, effective);
          content = render(document, options.format);
          if (document.warnings.length > 0) {
            hadWarnings = true;
            process.stderr.write(warningLines(document.warnings));
          }
          if (options.outDir) {
            await writeOutput(options.outDir, input, options.format, `${content}\n`, usedNames);
            continue;
          }
        }

        if (aggregateJson) {
          if (!aggregateStarted) {
            await writeStdout('[\n');
            aggregateStarted = true;
          } else {
            await writeStdout(',\n');
          }
          await writeStdout(content);
        } else {
          if (outputCount > 0)
            await writeStdout(options.format === 'json' || options.detectOnly ? '\n' : '\n\n');
          await writeStdout(content);
        }
        outputCount++;
      }
    } catch (error) {
      if (aggregateStarted) await writeStdout('\n]\n');
      throw error;
    }
    if (aggregateStarted) await writeStdout('\n]\n');
    else if (outputCount > 0) await writeStdout('\n');
    return options.strictExit && hadWarnings ? 2 : 0;
  } catch (error) {
    process.stderr.write(errorLine(error));
    return 1;
  }
}

/** True when this file is the program, also when npm runs it through a `bin` symlink. */
function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  void runCli().then((code) => {
    process.exitCode = code;
  });
}
