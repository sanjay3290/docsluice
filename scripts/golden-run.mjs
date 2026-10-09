#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CORPUS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../corpus');
const REPOSITORY_METADATA = new Set(['README', 'README.md', '.gitkeep', '.gitattributes']);
const MISSING_EXPECTED_INSTRUCTIONS =
  'Add reviewed expected files, or run `UPDATE_GOLDEN=1 node scripts/golden-run.mjs` locally to create or refresh them.';

function isSidecar(name) {
  return (
    REPOSITORY_METADATA.has(name) ||
    name.endsWith('.license') ||
    name.endsWith('.expected.json') ||
    name.endsWith('.expected.md') ||
    name.endsWith('.meta.json') ||
    name.endsWith('.metadata.json') ||
    name.endsWith('.native.txt') ||
    name.endsWith('.truth.md')
  );
}

async function assertNotSymlink(filePath, description) {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Error(`${description} must not be a symlink: ${filePath}`);
  return true;
}

async function discoverInputs(root) {
  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    throw new Error(`Cannot inspect corpus root ${root}.`, { cause: error });
  }
  if (rootStats.isSymbolicLink()) throw new Error(`Corpus root must not be a symlink: ${root}`);
  if (!rootStats.isDirectory()) throw new Error(`Corpus root must be a directory: ${root}`);

  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Corpus entries must not be symlinks: ${fullPath}`);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile()) {
        if (!isSidecar(entry.name)) files.push(fullPath);
      } else {
        throw new Error(`Unsupported filesystem entry in corpus: ${fullPath}`);
      }
    }
  }
  return files.sort((left, right) => {
    const leftRelative = path.relative(root, left);
    const rightRelative = path.relative(root, right);
    return leftRelative < rightRelative ? -1 : leftRelative > rightRelative ? 1 : 0;
  });
}

async function validateLicense(sourcePath) {
  const licensePath = `${sourcePath}.license`;
  let text;
  try {
    text = await readFile(licensePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `${path.basename(sourcePath)} is missing required .license sidecar at ${licensePath}.`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
  const lines = text.split(/\r?\n/);
  for (const field of ['SPDX-License-Identifier', 'Source']) {
    const matches = lines
      .map((line) => line.match(new RegExp(`^[\\t ]*${field}:[\\t ]*(.*?)[\\t ]*$`)))
      .filter((match) => match !== null);
    if (matches.length !== 1) {
      throw new Error(`${licensePath} must contain exactly one ${field} field.`);
    }
    if (!matches[0][1].trim()) {
      throw new Error(`${licensePath} must contain a non-empty ${field} line.`);
    }
  }
}

function firstDifference(expectedBytes, actualBytes) {
  const expected = expectedBytes.toString('utf8');
  const actual = actualBytes.toString('utf8');
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  let index = 0;
  while (
    index < expectedLines.length &&
    index < actualLines.length &&
    expectedLines[index] === actualLines[index]
  ) {
    index += 1;
  }
  const oldLine = expectedLines[index] ?? '<end of file>';
  const newLine = actualLines[index] ?? '<end of file>';
  let byteIndex = 0;
  while (
    byteIndex < expectedBytes.length &&
    byteIndex < actualBytes.length &&
    expectedBytes[byteIndex] === actualBytes[byteIndex]
  ) {
    byteIndex += 1;
  }
  const expectedByte = expectedBytes[byteIndex];
  const actualByte = actualBytes[byteIndex];
  const hex = (value) => (value === undefined ? '<end of file>' : `0x${value.toString(16).padStart(2, '0')}`);
  return `First differing byte at offset ${byteIndex}: expected ${hex(expectedByte)}, actual ${hex(actualByte)}.\nFirst difference at line ${index + 1}:\n- ${oldLine}\n+ ${newLine}`;
}

async function expectedText(expectedPath, actual, updateGolden, pendingWrites) {
  await assertNotSymlink(expectedPath, 'Expected-output files');
  let expected;
  try {
    expected = await readFile(expectedPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!updateGolden) {
      throw new Error(`${expectedPath} is missing expected output. ${MISSING_EXPECTED_INSTRUCTIONS}`, {
        cause: error,
      });
    }
    pendingWrites.push([expectedPath, actual]);
    return;
  }
  if (updateGolden) pendingWrites.push([expectedPath, actual]);
  else {
    const actualBytes = Buffer.from(actual);
    if (!expected.equals(actualBytes)) {
      throw new Error(`${expectedPath} differs.\n${firstDifference(expected, actualBytes)}`);
    }
  }
}

export function parseRunnerArgs(args, cwd = process.cwd()) {
  let corpusRoot = DEFAULT_CORPUS_ROOT;
  let sawCorpusRoot = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--corpus-root') throw new Error(`Unknown golden-runner argument: ${args[index]}`);
    if (sawCorpusRoot) throw new Error('--corpus-root may be specified only once.');
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--corpus-root requires a directory path.');
    corpusRoot = path.resolve(cwd, value);
    sawCorpusRoot = true;
    index += 1;
  }
  return { corpusRoot };
}

/** Run exact JSON and Markdown golden comparisons over a recursively discovered corpus. */
export async function runGoldenCorpus({
  corpusRoot = DEFAULT_CORPUS_ROOT,
  extract,
  toJSON,
  toMarkdown,
  updateGolden = false,
  ci = false,
} = {}) {
  if (typeof extract !== 'function' || typeof toJSON !== 'function' || typeof toMarkdown !== 'function') {
    throw new TypeError('Golden runner requires extract, toJSON, and toMarkdown functions.');
  }
  if (updateGolden && ci)
    throw new Error('UPDATE_GOLDEN=1 is forbidden on CI; review and update goldens locally.');

  const root = path.resolve(corpusRoot);
  const inputs = await discoverInputs(root);
  if (inputs.length === 0) throw new Error(`No corpus inputs found under ${root}.`);

  for (const sourcePath of inputs) {
    await validateLicense(sourcePath);
    await assertNotSymlink(`${sourcePath}.expected.json`, 'Expected-output files');
    await assertNotSymlink(`${sourcePath}.expected.md`, 'Expected-output files');
  }

  const pendingWrites = [];
  for (const sourcePath of inputs) {
    const bytes = new Uint8Array(await readFile(sourcePath));
    const doc = await extract(bytes, { filename: path.basename(sourcePath) });
    const json = `${toJSON(doc, { stable: true })}\n`;
    const markdown = toMarkdown(doc);
    await expectedText(`${sourcePath}.expected.json`, json, updateGolden, pendingWrites);
    await expectedText(`${sourcePath}.expected.md`, markdown, updateGolden, pendingWrites);
  }

  if (updateGolden) {
    for (const [expectedPath, content] of pendingWrites) {
      await assertNotSymlink(expectedPath, 'Expected-output files');
      const handle = await open(
        expectedPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
        0o666,
      );
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
    }
  }
  return { files: inputs.length, updated: updateGolden ? inputs.length : 0 };
}

async function main(args) {
  const { extract, toJSON, toMarkdown } = await import('../packages/docsluice/dist/index.js');
  const result = await runGoldenCorpus({
    ...parseRunnerArgs(args),
    extract,
    toJSON,
    toMarkdown,
    updateGolden: process.env.UPDATE_GOLDEN === '1',
    ci: Boolean(process.env.CI),
  });
  process.stdout.write(`Golden corpus passed: ${result.files} files checked, ${result.updated} updated.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
