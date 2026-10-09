import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const INSTALL_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall'];
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i;

export function parseRuntimeAllowlist(adrText) {
  const decisionStart = adrText.indexOf('## Decision');
  if (decisionStart < 0) throw new Error('ADR 0011 is missing its Decision section.');
  const decisionText = adrText.slice(decisionStart + '## Decision'.length);
  const nextSection = decisionText.search(/^## /m);
  const decision = nextSection < 0 ? decisionText : decisionText.slice(0, nextSection);

  const packages = new Set();
  for (const line of decision.split('\n')) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (match) packages.add(match[1]);
  }

  if (packages.size === 0) throw new Error('ADR 0011 has no runtime dependency rows.');
  return packages;
}

export function validateRuntimeDependencies({
  dependencies = {},
  optionalDependencies = {},
  peerDependencies = {},
  peerDependenciesMeta = {},
  allowlist,
  lockfile,
}) {
  if (!(allowlist instanceof Set)) throw new TypeError('allowlist must be a Set of package names.');
  const errors = [];
  const groups = {
    dependencies,
    optionalDependencies,
    peerDependencies: Object.fromEntries(
      Object.entries(peerDependencies).filter(([name]) => peerDependenciesMeta[name]?.optional !== true),
    ),
  };

  const declared = new Map();
  for (const group of Object.values(groups)) {
    for (const [name, version] of Object.entries(group)) {
      if (!allowlist.has(name)) errors.push(`${name} is not listed in ADR 0011.`);
      if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
        errors.push(`${name} must declare an exact version (for example, 1.2.3); found ${String(version)}.`);
      }

      const priorVersion = declared.get(name);
      if (priorVersion !== undefined && priorVersion !== version) {
        errors.push(`${name} dependency specs disagree: ${priorVersion} and ${version}.`);
      }
      declared.set(name, version);
    }
  }

  if (lockfile) {
    const workspace = lockfile.packages?.['packages/docsluice'];
    if (!workspace) {
      errors.push('package-lock.json is missing the packages/docsluice workspace entry.');
    } else {
      for (const [groupName, group] of Object.entries(groups)) {
        const lockedDependencies = workspace[groupName] ?? {};
        for (const [name, version] of Object.entries(group)) {
          const lockedSpec = lockedDependencies[name];
          if (lockedSpec !== version) {
            errors.push(
              `${name} package-lock ${groupName} spec ${String(lockedSpec)} does not match ${version}.`,
            );
          }
        }
      }

      for (const [name, version] of declared) {
        const installed = lockfile.packages?.[`node_modules/${name}`];
        if (!installed || installed.version !== version) {
          errors.push(
            `${name} package-lock version ${String(installed?.version)} does not match ${version}.`,
          );
        }
      }
    }
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
}

async function packageManifest(packageDir) {
  const manifestPath = path.join(packageDir, 'package.json');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    return { manifest, manifestPath };
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`Could not read ${manifestPath}: ${error.message}`, { cause: error });
  }
}

async function findNodeModules(dir) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return results;
    throw error;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.name.startsWith('@')) {
      let scopedEntries;
      try {
        scopedEntries = await readdir(entryPath, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      for (const scopedEntry of scopedEntries) {
        const packageDir = path.join(entryPath, scopedEntry.name);
        const found = await inspectPackage(packageDir);
        results.push(...found);
      }
    } else {
      results.push(...(await inspectPackage(entryPath)));
    }
  }

  return results;
}

async function inspectPackage(packageDir) {
  const found = [];
  const packageRealPath = await realpath(packageDir).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!packageRealPath) return found;

  const info = await packageManifest(packageRealPath);
  if (info) {
    for (const script of INSTALL_LIFECYCLE_SCRIPTS) {
      if (Object.hasOwn(info.manifest.scripts ?? {}, script)) {
        found.push({
          name: info.manifest.name ?? path.basename(packageDir),
          path: info.manifestPath,
          script,
        });
      }
    }

    const packageFiles = await readdir(packageRealPath);
    if (
      info.manifest.gypfile === true ||
      (packageFiles.includes('binding.gyp') && info.manifest.gypfile !== false)
    ) {
      found.push({
        name: info.manifest.name ?? path.basename(packageDir),
        path: info.manifestPath,
        script: 'gypfile',
      });
    }
  }

  found.push(...(await findNodeModules(path.join(packageRealPath, 'node_modules'))));
  return found;
}

export async function collectPackagesWithInstallScripts(root) {
  const nodeModulesPath = path.join(root, 'node_modules');
  try {
    if (!(await stat(nodeModulesPath)).isDirectory()) {
      throw new Error(`node_modules path is not a directory: ${nodeModulesPath}`);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`node_modules directory is missing: ${nodeModulesPath}`, { cause: error });
    }
    throw error;
  }

  const findings = await findNodeModules(nodeModulesPath);
  return findings.sort(
    (left, right) => left.path.localeCompare(right.path) || left.script.localeCompare(right.script),
  );
}

async function main() {
  const [packageJson, lockJson, adrText] = await Promise.all([
    readFile(path.join(REPO_ROOT, 'packages/docsluice/package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(REPO_ROOT, 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(path.join(REPO_ROOT, 'docs/adr/0011-dependency-policy.md'), 'utf8'),
  ]);
  const allowlist = parseRuntimeAllowlist(adrText);
  validateRuntimeDependencies({
    dependencies: packageJson.dependencies ?? {},
    optionalDependencies: packageJson.optionalDependencies ?? {},
    peerDependencies: packageJson.peerDependencies ?? {},
    peerDependenciesMeta: packageJson.peerDependenciesMeta ?? {},
    allowlist,
    lockfile: lockJson,
  });

  const installScripts = await collectPackagesWithInstallScripts(REPO_ROOT);
  if (installScripts.length > 0) {
    const details = installScripts.map(
      ({ name, path: manifestPath, script }) => `${name} (${script}): ${manifestPath}`,
    );
    throw new Error(
      `Installed packages must not define install lifecycle scripts or trigger node-gyp:\n${details.join('\n')}`,
    );
  }

  console.log(
    `Runtime dependencies match ADR 0011 (${packageJson.dependencies ? Object.keys(packageJson.dependencies).length : 0} declared).`,
  );
  console.log('No installed package defines an install lifecycle script or triggers node-gyp.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
