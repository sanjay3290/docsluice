import { runRuntimeContract } from './cases.mjs';
import { loadRuntimeFixtures } from './fixtures.generated.mjs';

// Node, Bun and Deno run the same embedded fixtures as the browser and Workers adapters.
await runRuntimeContract(loadRuntimeFixtures());
globalThis.console.log('Built-package portable runtime contract passed.');
