import { lstat, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requirementIdPattern = /^[A-Z][A-Z0-9]*-\d+$/u;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function parseRequirements(prd) {
  const allIds = new Set();
  const p0 = new Map();
  for (const line of prd.split(/\r?\n/u)) {
    const cells = splitTableRow(line);
    if (!cells || !requirementIdPattern.test(cells[0] ?? '')) continue;
    if (cells.length < 3) throw new Error(`Malformed P0 requirement row: ${line}`);
    const id = cells[0];
    allIds.add(id);
    if (cells.at(-1) !== 'P0') continue;
    if (p0.has(id)) throw new Error(`Duplicate P0 requirement id: ${id}`);
    p0.set(id, { description: cells.slice(1, -1).join(' | '), fixtures: [] });
  }
  if (p0.size === 0) throw new Error('No P0 requirements found in PRD');
  return { allIds, p0 };
}

function parseLicense(text, file) {
  const lines = text.split(/\r?\n/u);
  const values = new Map();
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator);
    if (!['SPDX-License-Identifier', 'Source', 'Requirements'].includes(field)) continue;
    if (values.has(field)) throw new Error(`Duplicate ${field} field in ${file}`);
    values.set(field, line.slice(separator + 1).trim());
  }
  for (const field of ['SPDX-License-Identifier', 'Source', 'Requirements']) {
    if (!values.has(field)) throw new Error(`Missing ${field} field in ${file}`);
  }
  if (!values.get('SPDX-License-Identifier') || !values.get('Source')) {
    throw new Error(`Empty license identity or source in ${file}`);
  }
  const raw = values.get('Requirements');
  if (!raw) throw new Error(`Requirements field must not be empty in ${file}`);
  const tags = raw.split(',').map((tag) => tag.trim());
  if (tags.some((tag) => !requirementIdPattern.test(tag)) || new Set(tags).size !== tags.length) {
    throw new Error(`Invalid Requirements field in ${file}`);
  }
  return tags;
}

function isMetadataFile(relativePath) {
  const basename = path.basename(relativePath);
  return (
    relativePath === 'README.md' ||
    basename === '.gitkeep' ||
    basename === '.gitattributes' ||
    relativePath.endsWith('.license') ||
    relativePath.endsWith('.expected.json') ||
    relativePath.endsWith('.expected.md')
  );
}

async function collectFiles(directory, corpusRoot, output = []) {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new Error(`Corpus symlink is not allowed: ${directory}`);
  if (!info.isDirectory()) throw new Error(`Corpus path is not a directory: ${directory}`);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(corpusRoot, absolute);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`Corpus path escapes corpus root: ${relative}`);
    }
    if (
      [...relative].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    ) {
      throw new Error(`Invalid corpus path: ${relative}`);
    }
    if (entry.isSymbolicLink()) throw new Error(`Corpus symlink is not allowed: ${relative}`);
    if (entry.isDirectory()) {
      await collectFiles(absolute, corpusRoot, output);
    } else if (entry.isFile() && !isMetadataFile(relative)) {
      output.push({ absolute, relative: relative.split(path.sep).join('/') });
    } else if (!entry.isFile()) {
      throw new Error(`Unsupported corpus filesystem entry: ${relative}`);
    }
  }
  return output;
}

function escapeCell(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('`', '\\`');
}

function escapePath(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replaceAll('`', '&#96;');
}

async function goldenStatus(file) {
  const json = await exists(`${file}.expected.json`);
  const markdown = await exists(`${file}.expected.md`);
  if (json && markdown) return 'JSON and Markdown present';
  if (json) return 'JSON present; Markdown missing';
  if (markdown) return 'Markdown present; JSON missing';
  return 'neither present';
}

async function exists(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`Golden file symlink is not allowed: ${file}`);
    return info.isFile();
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Generate an inventory from P0 PRD rows and licensed corpus requirement tags. */
export async function generateSupportMatrix({ root = defaultRoot, prdPath = 'docs/prd.md' } = {}) {
  const absoluteRoot = path.resolve(root);
  const { allIds, p0: requirements } = parseRequirements(
    await readFile(path.join(absoluteRoot, prdPath), 'utf8'),
  );
  const corpusRoot = path.join(absoluteRoot, 'corpus');
  const files = await collectFiles(corpusRoot, corpusRoot);
  for (const file of files) {
    const licensePath = `${file.absolute}.license`;
    const tags = parseLicense(
      await readFile(licensePath, 'utf8').catch((error) => {
        if (error && typeof error === 'object' && error.code === 'ENOENT') {
          throw new Error(`Corpus fixture is missing license sidecar: ${file.relative}`);
        }
        throw error;
      }),
      `${file.relative}.license`,
    );
    for (const tag of tags) {
      if (!allIds.has(tag)) throw new Error(`Unknown requirement tag ${tag} in ${file.relative}.license`);
      if (!requirements.has(tag)) continue;
      requirements.get(tag).fixtures.push({
        path: file.relative,
        goldens: await goldenStatus(file.absolute),
      });
    }
  }

  const rows = [...requirements.entries()].sort(([left], [right]) => compareText(left, right));
  const lines = [
    '# Format support matrix',
    '',
    'This page inventories P0 requirements, corpus license metadata, and golden-file presence.',
    'Fixture requirement tags are attribution metadata, not proof of support. Golden-file presence',
    'is reported separately and does not mean output was reviewed or that a requirement passes.',
    'No extraction or support claim is inferred by this generator.',
    '',
    '| Requirement | PRD requirement | Tagged licensed fixtures | Golden files present |',
    '|---|---|---|---|',
  ];
  for (const [id, requirement] of rows) {
    const fixtures = requirement.fixtures
      .sort((left, right) => compareText(left.path, right.path))
      .map(({ path: filePath }) => `<code>${escapePath(filePath)}</code>`);
    const goldens = requirement.fixtures
      .sort((left, right) => compareText(left.path, right.path))
      .map(({ path: filePath, goldens: status }) => `<code>${escapePath(filePath)}</code>: ${status}`);
    lines.push(
      `| ${id} | ${escapeCell(requirement.description)} | ${fixtures.length ? fixtures.join('<br>') : 'Not covered'} | ${goldens.length ? goldens.join('<br>') : 'No tagged fixture'} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export async function checkSupportMatrix({ root = defaultRoot } = {}) {
  const expected = await generateSupportMatrix({ root });
  const outputPath = path.join(root, 'docs/formats/support-matrix.md');
  try {
    return (await readFile(outputPath, 'utf8')) === expected;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function writeSupportMatrix({ root = defaultRoot } = {}) {
  const outputPath = path.join(root, 'docs/formats/support-matrix.md');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, await generateSupportMatrix({ root }));
}

async function main(argv) {
  let root = defaultRoot;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--check') check = true;
    else if (argv[index] === '--root' && argv[index + 1]) root = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (check) {
    if (!(await checkSupportMatrix({ root }))) {
      process.stderr.write('Support matrix is out of date; run node scripts/docs-support.mjs.\n');
      return 1;
    }
    return 0;
  }
  await writeSupportMatrix({ root });
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
