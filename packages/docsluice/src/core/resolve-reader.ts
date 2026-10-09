import type { Budget } from './budget.js';
import type { ExtractOptions } from './options.js';
import type { FormatResolution } from '../detect/detect.js';
import { resolveFormat } from '../detect/detect.js';
import type { ReaderRegistry } from './registry.js';

/** Resolve built-in content first, then consider registry plugins at the same boundary. */
export async function resolveFormatWithRegistry(
  bytes: Uint8Array,
  options: Pick<ExtractOptions, 'filename' | 'mimeType' | 'format'>,
  budget: Budget,
  registry: ReaderRegistry,
): Promise<FormatResolution> {
  let resolution = await resolveFormat(bytes, options, budget);
  if (options.format !== undefined) {
    const mimeType = registry.pluginMimeType(options.format, options.mimeType);
    return mimeType ? { ...resolution, result: { ...resolution.result, mimeType } } : resolution;
  }
  const probe = registry.resolvePlugin(bytes, options, resolution.result.confidence);
  if (probe.ambiguous) {
    budget.warnings.add({
      code: 'FORMAT_MISMATCH',
      message: 'Multiple registered plugins matched uncertain content; no plugin was selected.',
    });
    return resolution;
  }
  const plugin = probe.selection;
  if (plugin) {
    resolution = {
      ...resolution,
      result: {
        ...resolution.result,
        format: plugin.id,
        mimeType: plugin.mimeType,
        confidence: plugin.confidence,
      },
    };
  } else if (resolution.result.confidence >= 0.8 && registry.hasPluginHint(options)) {
    budget.warnings.add({
      code: 'FORMAT_MISMATCH',
      message: `Detected format "${resolution.result.format}" takes precedence over the registered plugin hint.`,
    });
  }
  return resolution;
}
