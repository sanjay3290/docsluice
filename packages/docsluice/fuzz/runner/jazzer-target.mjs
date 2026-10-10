import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const buildDir = globalThis.process.env.DOCSLUICE_FUZZ_BUILD_DIR;
const targetName = globalThis.process.env.DOCSLUICE_FUZZ_TARGET;
// scripts/fuzz-run.mjs owns the target table and passes the compiled module and export.
const targetModule = globalThis.process.env.DOCSLUICE_FUZZ_MODULE;
const targetExport = globalThis.process.env.DOCSLUICE_FUZZ_EXPORT;

if (!buildDir || !targetName || !targetModule || !targetExport) {
  throw new Error(`Unknown or unbuilt DOCSLUICE_FUZZ_TARGET: ${targetName ?? '(unset)'}`);
}

const modulePath = (path) => pathToFileURL(resolve(buildDir, path)).href;
const [{ DocsluiceError }, target] = await Promise.all([
  import(modulePath('src/core/errors.js')),
  targetName === 'zip' ? import('./strict-zip.fuzz.mjs') : import(modulePath(targetModule)),
]);
const runInput = targetName === 'zip' ? target.fuzzZipStrict : target[targetExport];
if (typeof runInput !== 'function')
  throw new Error(`Fuzz target ${targetName} has no ${targetExport} export`);

const prototypes = [
  ...new Set([
    DocsluiceError.prototype,
    ...Reflect.ownKeys(globalThis)
      .map((key) => Object.getOwnPropertyDescriptor(globalThis, key)?.value)
      .filter((value) => typeof value === 'function')
      .map((constructor) => Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value)
      .filter((prototype) => prototype && typeof prototype === 'object'),
  ]),
];

function descriptorSnapshot(prototype) {
  return {
    parent: Object.getPrototypeOf(prototype),
    properties: Reflect.ownKeys(prototype).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(prototype, key),
    ]),
  };
}

function sameDescriptor(a, b) {
  return (
    a?.configurable === b?.configurable &&
    a?.enumerable === b?.enumerable &&
    a?.writable === b?.writable &&
    a?.value === b?.value &&
    a?.get === b?.get &&
    a?.set === b?.set
  );
}

const pristine = prototypes.map(descriptorSnapshot);

/** Jazzer.js calls this ESM entry point once for each input. */
export async function fuzz(input) {
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let expectedError = false;
  try {
    await runInput(bytes);
  } catch (error) {
    if (!(error instanceof DocsluiceError)) throw error;
    expectedError = true;
  }
  for (let index = 0; index < prototypes.length; index += 1) {
    const current = descriptorSnapshot(prototypes[index]);
    const baseline = pristine[index];
    if (
      current.parent !== baseline.parent ||
      current.properties.length !== baseline.properties.length ||
      current.properties.some(
        ([key, descriptor], item) =>
          key !== baseline.properties[item]?.[0] ||
          !sameDescriptor(descriptor, baseline.properties[item]?.[1]),
      )
    ) {
      throw new Error('fuzz input changed a built-in prototype');
    }
  }
  if (expectedError) return;
}
