import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const conversions = new Map([
  [
    'fodt',
    new Map([
      ['docx', 'docx:Office Open XML Text'],
      ['odt', 'odt:writer8'],
      ['rtf', 'rtf:Rich Text Format'],
      ['pdf', 'pdf:writer_pdf_Export'],
    ]),
  ],
  [
    'fods',
    new Map([
      ['xlsx', 'xlsx:Calc MS Excel 2007 XML'],
      ['ods', 'ods:calc8'],
    ]),
  ],
  [
    'fodp',
    new Map([
      ['pptx', 'pptx:Impress MS PowerPoint 2007 XML'],
      ['odp', 'odp:impress8'],
      ['pdf', 'pdf:impress_pdf_Export'],
    ]),
  ],
]);
const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const maxOutputBytes = 16 * 1024 * 1024;

export function validatePlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0 || plan.length > 100) {
    throw new Error('Fixture plan must contain between 1 and 100 sources');
  }
  const jobs = [];
  const seen = new Set();
  for (const entry of plan) {
    if (
      !entry ||
      typeof entry.source !== 'string' ||
      !/^src\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:fodt|fods|fodp)$/.test(entry.source)
    ) {
      throw new Error('Invalid fixture source path');
    }
    const extension = path.extname(entry.source).slice(1);
    const allowed = conversions.get(extension);
    if (!allowed) throw new Error('Unsupported source extension');
    if (!Array.isArray(entry.formats) || entry.formats.length === 0) throw new Error('Formats are required');
    if (entry.pdfPassword !== undefined) {
      if (!entry.formats.includes('pdf')) throw new Error('PDF password can only be used with PDF outputs');
      if (
        typeof entry.pdfPassword !== 'string' ||
        entry.pdfPassword.length < 1 ||
        entry.pdfPassword.length > 64 ||
        Array.from(entry.pdfPassword).some((character) => {
          const code = character.charCodeAt(0);
          return code < 0x21 || code > 0x7e;
        })
      ) {
        throw new Error('PDF fixture password must be 1 to 64 printable ASCII characters');
      }
    }
    if (
      !Array.isArray(entry.requirements) ||
      entry.requirements.length === 0 ||
      !entry.requirements.every((tag) => typeof tag === 'string' && /^[A-Z]+-[1-9]\d*$/.test(tag))
    ) {
      throw new Error('Requirement tags are required');
    }
    for (const format of entry.formats) {
      if (!allowed.has(format)) throw new Error('Source and output format mismatch');
      const basename = path.basename(entry.source, '.' + extension);
      const file = format + '/' + basename + '.' + format;
      if (seen.has(file)) throw new Error('Duplicate fixture output');
      seen.add(file);
      let conversion = allowed.get(format);
      if (format === 'pdf' && entry.pdfPassword !== undefined) {
        conversion +=
          ':' +
          JSON.stringify({
            EncryptFile: { type: 'boolean', value: 'true' },
            DocumentOpenPassword: { type: 'string', value: entry.pdfPassword },
          });
      }
      jobs.push({ ...entry, format, conversion, file });
    }
  }
  return jobs;
}

function execute(soffice, args, timeoutMs, label) {
  const result = spawnSync(soffice, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 512 * 1024,
    windowsHide: true,
    shell: false,
  });
  if (result.error?.code === 'ETIMEDOUT') throw new Error(label + ' timeout');
  if (result.error) throw new Error(label + ' failed: ' + (result.error.code ?? 'spawn error'));
  if (result.status !== 0) throw new Error(label + ' failed with exit ' + result.status);
  return result.stdout.trim();
}

function assertSignature(bytes, format) {
  const valid =
    format === 'pdf'
      ? bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
      : format === 'rtf'
        ? bytes.subarray(0, 5).equals(Buffer.from('{\\rtf'))
        : bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (!valid) throw new Error('Invalid ' + format + ' output signature');
}

async function installAtomically(staged, target) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(path.dirname(target), '.docsluice-building-'));
  const temporary = path.join(temporaryDirectory, 'output');
  try {
    await copyFile(staged, temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function buildFixtures({
  root = defaultRoot,
  outputRoot = path.join(root, 'corpus'),
  soffice = process.env.SOFFICE ?? 'soffice',
  timeoutMs = 60_000,
  plan,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error('Timeout must be a positive integer');
  const sourceRoot = path.join(root, 'scripts/corpus');
  const actualPlan = plan ?? JSON.parse(await readFile(path.join(sourceRoot, 'fixture-plan.json'), 'utf8'));
  const jobs = validatePlan(actualPlan);
  const canonicalRoot = await realpath(sourceRoot);
  for (const job of jobs) {
    const source = path.join(sourceRoot, job.source);
    let canonical;
    try {
      canonical = await realpath(source);
    } catch {
      throw new Error('Missing fixture source: ' + job.source);
    }
    if (!canonical.startsWith(canonicalRoot + path.sep))
      throw new Error('Fixture source escapes source root');
    if (!(await stat(source)).isFile()) throw new Error('Fixture source is not a regular file');
    job.absoluteSource = canonical;
  }
  const version = execute(soffice, ['--version'], Math.max(5000, timeoutMs), 'LibreOffice');
  if (!/LibreOffice/i.test(version) || version.includes('\n') || version.length > 200) {
    throw new Error('Unexpected LibreOffice version response');
  }
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'docsluice-corpus-build-'));
  try {
    const staged = [];
    for (const [index, job] of jobs.entries()) {
      const conversionDir = path.join(temporaryRoot, String(index), 'output');
      const profileDir = path.join(temporaryRoot, String(index), 'profile');
      await mkdir(conversionDir, { recursive: true });
      execute(
        soffice,
        [
          '-env:UserInstallation=' + pathToFileURL(profileDir).href,
          '--headless',
          '--nologo',
          '--nodefault',
          '--norestore',
          '--convert-to',
          job.conversion,
          '--outdir',
          conversionDir,
          job.absoluteSource,
        ],
        timeoutMs,
        job.format + ' conversion',
      );
      const output = path.join(conversionDir, path.basename(job.file));
      let size;
      try {
        size = (await stat(output)).size;
      } catch {
        throw new Error('Missing output for ' + job.file);
      }
      if (size < 8 || size > maxOutputBytes) throw new Error('Invalid output size for ' + job.file);
      const bytes = await readFile(output);
      assertSignature(bytes, job.format);
      const notes = job.pdfPassword
        ? 'Notes: Synthetic fixture; fixed public password for opening this test PDF: ' + job.pdfPassword + '.'
        : 'Notes: Synthetic fixture; requirement association needs reader-owner golden review.';
      const license = [
        'SPDX-License-Identifier: CC0-1.0',
        'Source: made for docsluice with ' + version + ' from scripts/corpus/' + job.source,
        'Requirements: ' + job.requirements.join(', '),
        notes,
        '',
      ].join('\n');
      await writeFile(output + '.license', license);
      staged.push({
        output,
        file: job.file,
        source: 'scripts/corpus/' + job.source,
        requirements: job.requirements,
        sizeBytes: size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    // Do not replace any tracked fixture until every conversion is validated.
    for (const item of staged) {
      await installAtomically(item.output, path.join(outputRoot, item.file));
      await installAtomically(item.output + '.license', path.join(outputRoot, item.file + '.license'));
    }
    const relativeOutput = path.relative(root, outputRoot);
    const outputs = staged.map((item) => ({
      source: item.source,
      requirements: item.requirements,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
      file: relativeOutput ? relativeOutput.split(path.sep).join('/') + '/' + item.file : item.file,
      goldenStatus: 'unreviewed',
    }));
    return { version, outputs };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      soffice: { type: 'string' },
      output: { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'Usage: node scripts/corpus/build.mjs [--soffice PATH] [--output DIR] [--timeout-ms 60000]\n',
    );
    return;
  }
  const result = await buildFixtures({
    soffice: values.soffice,
    outputRoot: values.output ? path.resolve(values.output) : undefined,
    timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
  });
  await writeFile(
    path.join(defaultRoot, 'scripts/corpus/manifest-delta.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  process.stdout.write('Built ' + result.outputs.length + ' fixtures with ' + result.version + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write('Corpus build failed: ' + error.message + '\n');
    process.exitCode = 1;
  });
}
