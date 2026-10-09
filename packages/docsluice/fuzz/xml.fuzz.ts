import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { parseXml, scanXml } from '../src/xml/index.js';
import type { XmlContext } from '../src/xml/index.js';

function context(): XmlContext {
  const warnings = new WarningSink();
  return {
    budget: new Budget({ ...DEFAULT_LIMITS, xmlDepth: 64, outputChars: 65_536, timeMs: 1000 }, { warnings }),
    warnings,
  };
}

/** Fuzz harness entry point: supply arbitrary bytes to cover both XML APIs. */
export function fuzzXml(input: Uint8Array): void {
  scanXml(input, {}, context());
  parseXml(input, context());
}
