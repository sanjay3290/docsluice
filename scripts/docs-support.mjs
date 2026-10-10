// Builds docs/formats/support-matrix.md from the corpus, its .license requirement tags, the hostile
// manifest and the PRD, so the page cannot drift from the truth (PRD section 20). `--check` exits 1
// when the committed page is out of date.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = 'docs/formats/support-matrix.md';
const SIDECARS = ['.license', '.expected.json', '.expected.md', '.blocks.json', '.native.txt'];
const METADATA = new Set(['README.md', '.gitattributes', '.gitkeep']);
/** Package subpaths that are not format readers. */
const NOT_READERS = new Set(['.', './node', './worker', './schema.json', './package.json']);

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function isRequirementId(value) {
  const dash = value.indexOf('-');
  if (dash < 1 || dash === value.length - 1) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    const upper = code >= 65 && code <= 90;
    const digit = code >= 48 && code <= 57;
    if (index < dash ? !upper : index > dash && !digit) return false;
  }
  return true;
}

/** Requirement rows of the PRD tables: `| ID | text | priority |`. */
export function parseRequirements(prd) {
  const requirements = new Map();
  for (const line of prd.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    // An escaped `\|` inside a cell is text, not a column break.
    const cells = trimmed
      .slice(1, -1)
      .replaceAll('\\|', '\u0000')
      .split('|')
      .map((cell) => cell.replaceAll('\u0000', '|').trim());
    if (!isRequirementId(cells[0] ?? '')) continue;
    const priority = cells.at(-1);
    if (!/^P[0-2]$/.test(priority ?? '')) continue;
    if (requirements.has(cells[0])) throw new Error(`Duplicate requirement ${cells[0]} in the PRD.`);
    requirements.set(cells[0], { text: cells.slice(1, -1).join(' | '), priority });
  }
  if (requirements.size === 0) throw new Error('No requirement rows found in the PRD.');
  return requirements;
}

/** The `Requirements:` tags of a corpus `.license` file. */
export function parseLicenseTags(text, file, requirements) {
  const lines = text.split('\n').filter((line) => line.startsWith('Requirements:'));
  if (lines.length !== 1) throw new Error(`${file} needs exactly one "Requirements:" line.`);
  const tags = lines[0]
    .slice('Requirements:'.length)
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (tags.length === 0) throw new Error(`${file} has an empty "Requirements:" line.`);
  for (const tag of tags) {
    if (!requirements.has(tag)) throw new Error(`${file} names ${tag}, which is not a PRD requirement.`);
  }
  if (new Set(tags).size !== tags.length) throw new Error(`${file} repeats a requirement.`);
  return tags;
}

function corpusInputs(corpus) {
  if (!existsSync(corpus)) return [];
  return readdirSync(corpus, { recursive: true })
    .map((name) => String(name).replaceAll('\\', '/'))
    .filter((name) => {
      const base = name.slice(name.lastIndexOf('/') + 1);
      return name.includes('/') && base.includes('.') && !METADATA.has(base);
    })
    .filter((name) => !SIDECARS.some((suffix) => name.endsWith(suffix)))
    .sort(compare);
}

const cell = (value) => value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ');
const code = (value) => `\`${value}\``;

/** Generate the support matrix page. */
export function generateSupportMatrix(root = defaultRoot) {
  const requirements = parseRequirements(readFileSync(path.join(root, 'docs/prd.md'), 'utf8'));
  const corpus = path.join(root, 'corpus');
  const manifest = JSON.parse(readFileSync(path.join(root, 'packages/docsluice/package.json'), 'utf8'));
  const readers = Object.keys(manifest.exports ?? {})
    .filter((subpath) => !NOT_READERS.has(subpath))
    .map((subpath) => subpath.slice(2));

  const byFormat = new Map();
  const byRequirement = new Map();
  for (const input of corpusInputs(corpus)) {
    const format = input.slice(0, input.indexOf('/'));
    const license = path.join(corpus, `${input}.license`);
    if (!existsSync(license)) throw new Error(`corpus/${input} has no .license file.`);
    const tags = parseLicenseTags(readFileSync(license, 'utf8'), `corpus/${input}.license`, requirements);
    const golden =
      existsSync(path.join(corpus, `${input}.expected.json`)) &&
      existsSync(path.join(corpus, `${input}.expected.md`));
    const entry = byFormat.get(format) ?? { files: 0, goldens: 0 };
    entry.files++;
    if (golden) entry.goldens++;
    byFormat.set(format, entry);
    for (const tag of tags) {
      const list = byRequirement.get(tag) ?? [];
      list.push(`${input}${golden ? '' : ' (no golden)'}`);
      byRequirement.set(tag, list);
    }
  }

  const hostile = new Map();
  for (const entry of JSON.parse(readFileSync(path.join(root, 'hostile/manifest.json'), 'utf8'))) {
    // Some entries name a roadmap item (`R2`) instead of a PRD requirement; those do not count here.
    if (typeof entry.requirement !== 'string' || !requirements.has(entry.requirement)) continue;
    hostile.set(entry.requirement, (hostile.get(entry.requirement) ?? 0) + 1);
  }

  const formats = [...new Set([...readers, ...byFormat.keys()])].sort(compare);
  const lines = [
    '# Format support matrix',
    '',
    '<!-- Generated by `npm run docs:support` (scripts/docs-support.mjs). Do not edit by hand. -->',
    '',
    'Built from the corpus, the `Requirements:` tags in each `.license` file, the hostile manifest and the PRD.',
    'A tag says a file exercises a requirement; the golden test checks its reviewed output. "Not covered" means',
    'no corpus or hostile file is tagged with that requirement; it may still have unit tests.',
    '',
    '## Formats',
    '',
    '| Format | Reader | Corpus files | With goldens | Format page |',
    '|---|---|---|---|---|',
  ];
  for (const format of formats) {
    const reader = readers.includes(format);
    const page = `docs/formats/${format}.md`;
    const hasPage = existsSync(path.join(root, page));
    if (reader && !hasPage) throw new Error(`The ${format} reader has no ${page}.`);
    const entry = byFormat.get(format) ?? { files: 0, goldens: 0 };
    lines.push(
      `| ${format} | ${reader ? code(`docsluice/${format}`) : 'no reader'} | ${entry.files} | ${entry.goldens} | ${
        hasPage ? `[${format}.md](${format}.md)` : '—'
      } |`,
    );
  }
  lines.push(
    '',
    '## P0 requirements',
    '',
    '| Requirement | Text | Corpus files | Hostile files |',
    '|---|---|---|---|',
  );
  let covered = 0;
  let total = 0;
  for (const [id, requirement] of [...requirements].sort(([left], [right]) => compare(left, right))) {
    if (requirement.priority !== 'P0') continue;
    total++;
    const files = (byRequirement.get(id) ?? []).sort(compare);
    const hostileCount = hostile.get(id) ?? 0;
    if (files.length > 0 || hostileCount > 0) covered++;
    lines.push(
      `| ${id} | ${cell(requirement.text)} | ${
        files.length > 0 ? files.map((file) => code(file)).join('<br>') : 'Not covered'
      } | ${hostileCount > 0 ? String(hostileCount) : '—'} |`,
    );
  }
  lines.push('', `${covered} of ${total} P0 requirements have at least one corpus or hostile file.`, '');
  return lines.join('\n');
}

/** Whether the committed page matches what the generator writes. */
export function checkSupportMatrix(root = defaultRoot) {
  const file = path.join(root, OUTPUT);
  return existsSync(file) && readFileSync(file, 'utf8') === generateSupportMatrix(root);
}

function main(argv) {
  const check = argv.includes('--check');
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex >= 0 && argv[rootIndex + 1] ? path.resolve(argv[rootIndex + 1]) : defaultRoot;
  if (check) {
    if (checkSupportMatrix(root)) return 0;
    process.stderr.write(`${OUTPUT} is out of date; run npm run docs:support.\n`);
    return 1;
  }
  writeFileSync(path.join(root, OUTPUT), generateSupportMatrix(root));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
