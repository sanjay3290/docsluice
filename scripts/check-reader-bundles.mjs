import { gzipSync } from 'node:zlib';
import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIRECTORY = resolve(SCRIPT_DIRECTORY, '../packages/docsluice');
const OFFICE_READER_BUDGETS = new Map([['doc', 40 * 1000]]);
const OFFICE_SUBPATH = /^\.\/(?:doc|docx|docm|xls|xlsx|xlsm|xlsb|ppt|pptx|pptm|odt|ods|odp)$/;

function chunksFrom(output) {
  return output.filter((item) => item.type === 'chunk');
}

function includesModule(chunk, moduleId) {
  return chunk.moduleIds.includes(moduleId) || Object.hasOwn(chunk.modules, moduleId);
}

function chunkByFileName(chunks) {
  return new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
}

/** Returns office reader exports and rejects missing or unregistered subpaths. */
export async function getOfficeReaderExports({ packageJson, expected }) {
  const exports = packageJson.exports;
  if (!exports || typeof exports !== 'object') {
    throw new Error('Package exports are missing; cannot check Office reader budgets.');
  }

  const actual = Object.keys(exports)
    .filter((subpath) => OFFICE_SUBPATH.test(subpath))
    .map((subpath) => subpath.slice(2))
    .sort();
  const configured = [...expected].sort();
  const unconfigured = actual.filter((subpath) => !configured.includes(subpath));
  if (unconfigured.length > 0) {
    throw new Error(`Office reader exports have no configured budgets: ${unconfigured.join(', ')}.`);
  }

  const missing = configured.filter((subpath) => !actual.includes(subpath));
  if (missing.length > 0) {
    throw new Error(`Package is missing expected Office reader export(s): ${missing.join(', ')}.`);
  }

  return configured.map((subpath) => {
    const exportConfig = exports[`./${subpath}`];
    const entry = typeof exportConfig === 'string' ? exportConfig : exportConfig?.import;
    if (typeof entry !== 'string' || !entry.startsWith('./dist/') || !entry.endsWith('.js')) {
      throw new Error(`Office reader export ./${subpath} must declare an ESM dist entry.`);
    }
    return { subpath, entry };
  });
}

/** Throws if any emitted JavaScript chunk exceeds the aggregate gzip budget. */
export function assertGzipBudget(label, emittedChunks, limitBytes) {
  const chunks = chunksFrom(emittedChunks);
  if (chunks.length === 0) throw new Error(`${label} bundle emitted no JavaScript chunks.`);
  const gzipBytes = chunks.reduce((sum, chunk) => sum + gzipSync(chunk.code).byteLength, 0);
  if (gzipBytes > limitBytes) {
    throw new Error(`${label} gzip size ${gzipBytes} bytes exceeds ${limitBytes} bytes.`);
  }
  return gzipBytes;
}

/** Confirms the public entry is reader-free and all declared readers are lazy chunks. */
export function assertLazyReaderGraph(output, options) {
  const { entryModule, readerModules } = options;
  const chunks = chunksFrom(output);
  const entry = chunks.find((chunk) => chunk.isEntry && includesModule(chunk, entryModule));
  if (!entry) throw new Error(`Bundle has no public entry chunk for ${entryModule}.`);

  const readers = readerModules ?? (options.readerModule ? [options.readerModule] : []);
  const byName = chunkByFileName(chunks);
  const reachableStaticChunks = new Set();
  const visitStatic = (current) => {
    if (reachableStaticChunks.has(current)) return;
    reachableStaticChunks.add(current);
    for (const fileName of current.imports) {
      const dependency = byName.get(fileName);
      if (dependency) visitStatic(dependency);
    }
  };
  visitStatic(entry);
  const eager = readers.filter((moduleId) =>
    [...reachableStaticChunks].some((chunk) => includesModule(chunk, moduleId)),
  );
  if (eager.length > 0) {
    throw new Error(`Public entry eagerly includes reader module(s): ${eager.join(', ')}.`);
  }

  const reachableDynamicChunks = new Set();
  const visited = new Set();
  const visit = (current, dynamicPath) => {
    if (visited.has(`${current.fileName}:${dynamicPath}`)) return;
    visited.add(`${current.fileName}:${dynamicPath}`);
    if (dynamicPath) reachableDynamicChunks.add(current);
    for (const fileName of current.imports) {
      const dependency = byName.get(fileName);
      if (dependency) visit(dependency, dynamicPath);
    }
    for (const fileName of current.dynamicImports) {
      const dependency = byName.get(fileName);
      if (dependency) visit(dependency, true);
    }
  };
  visit(entry, false);

  for (const readerModule of readers) {
    const readerChunks = chunks.filter((chunk) => includesModule(chunk, readerModule));
    if (readerChunks.length === 0) {
      throw new Error(`Bundle does not contain declared reader module ${readerModule}.`);
    }
    if (!readerChunks.some((chunk) => reachableDynamicChunks.has(chunk))) {
      throw new Error(`Declared reader module ${readerModule} is not reachable through a dynamic chunk.`);
    }
  }
  return true;
}

async function bundleEntry(entry, plugins = []) {
  const bundle = await rolldown({
    input: entry,
    platform: 'neutral',
    plugins,
    treeshake: true,
  });
  try {
    const { output } = await bundle.generate({ format: 'esm', chunkFileNames: 'chunks/[name]-[hash].js' });
    return output;
  } finally {
    await bundle.close();
  }
}

async function bundlePublicConsumer(publicEntry) {
  const consumerModuleId = '\0reader-bundle-consumer';
  const plugin = {
    name: 'reader-bundle-consumer',
    resolveId(source) {
      if (source === consumerModuleId) return consumerModuleId;
      if (source === 'docsluice') return publicEntry;
      return null;
    },
    load(id) {
      if (id === consumerModuleId) return 'import { extract } from "docsluice"; export { extract };';
      return null;
    },
  };
  return { output: await bundleEntry(consumerModuleId, [plugin]), consumerModuleId };
}

function entryPath(packageDirectory, entry) {
  const absolutePath = resolve(packageDirectory, entry);
  if (!absolutePath.startsWith(`${packageDirectory}/`)) {
    throw new Error(`Export entry escapes the package: ${entry}.`);
  }
  return absolutePath;
}

/** Bundles the built public entry and reader exports and checks their budget/lazy graph. */
export async function checkBuiltPackage({ packageDirectory = PACKAGE_DIRECTORY } = {}) {
  const packageJson = JSON.parse(await readFile(resolve(packageDirectory, 'package.json'), 'utf8'));
  const readers = await getOfficeReaderExports({
    packageJson,
    expected: [...OFFICE_READER_BUDGETS.keys()],
  });
  const publicExport = packageJson.exports['.'];
  const publicEntry = typeof publicExport === 'string' ? publicExport : publicExport?.import;
  if (typeof publicEntry !== 'string' || !publicEntry.startsWith('./dist/')) {
    throw new Error('Package public export is missing an ESM dist entry.');
  }

  const publicEntryPath = entryPath(packageDirectory, publicEntry);
  const readerEntries = readers.map(({ subpath, entry }) => ({
    subpath,
    path: entryPath(packageDirectory, entry),
    budget: OFFICE_READER_BUDGETS.get(subpath),
  }));
  await Promise.all([publicEntryPath, ...readerEntries.map(({ path }) => path)].map((path) => access(path)));

  const { output: publicOutput, consumerModuleId } = await bundlePublicConsumer(publicEntryPath);
  assertLazyReaderGraph(publicOutput, {
    entryModule: consumerModuleId,
    readerModules: readerEntries.map(({ path }) => path),
  });

  const readerResults = [];
  for (const reader of readerEntries) {
    const output = await bundleEntry(reader.path);
    const gzipBytes = assertGzipBudget(`docsluice/${reader.subpath}`, output, reader.budget);
    readerResults.push({ subpath: reader.subpath, gzipBytes, limitBytes: reader.budget });
  }
  return { publicEntry: publicEntryPath, readers: readerResults };
}

if (
  process.argv[1] &&
  isAbsolute(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await checkBuiltPackage();
  for (const reader of result.readers) {
    process.stdout.write(
      `docsluice/${reader.subpath}: ${reader.gzipBytes} / ${reader.limitBytes} gzip bytes\n`,
    );
  }
  process.stdout.write(`Public entry lazy-load graph: ${result.publicEntry}\n`);
}
