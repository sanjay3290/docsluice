import type { Budget } from './budget.js';
import type { FormatResolution } from '../detect/detect.js';
import type { FormatPlugin, ReaderRegistry } from './registry.js';

/** Built-in detection at or above this confidence is not second-guessed by plugin probes. */
const CONFIDENT = 0.9;

function extensionOf(filename: string | undefined): string | undefined {
  if (filename === undefined) return undefined;
  const basename = filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1);
  const dot = basename.lastIndexOf('.');
  return dot < 0 || dot === basename.length - 1 ? undefined : basename.slice(dot + 1).toLowerCase();
}

function hinted(plugin: FormatPlugin, hints: { filename?: string; mimeType?: string }): boolean {
  const extension = extensionOf(hints.filename);
  const mimeType = hints.mimeType?.toLowerCase();
  return (
    (extension !== undefined &&
      (plugin.extensions ?? []).some((value) => value.toLowerCase() === extension)) ||
    (mimeType !== undefined && (plugin.mimeTypes ?? []).some((value) => value.toLowerCase() === mimeType))
  );
}

function probe(plugin: FormatPlugin, bytes: Uint8Array): number {
  if (typeof plugin.detect !== 'function') return 0;
  try {
    const confidence = plugin.detect(bytes);
    return Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
  } catch {
    // A failing probe is a "no", not a crash of the whole extraction.
    return 0;
  }
}

/**
 * Let registered plugins claim a document (EXT-4). Plugins never override a forced `format`.
 * A plugin whose MIME type or extension matches the caller's hint wins unless its probe says 0;
 * otherwise plugin probes run only when built-in detection is not confident, and the highest
 * probe above the built-in confidence wins (registration order breaks ties).
 */
export function resolvePlugin(
  registry: ReaderRegistry,
  bytes: Uint8Array,
  hints: { filename?: string; mimeType?: string; format?: string },
  resolution: FormatResolution,
  budget: Budget,
): FormatResolution {
  const plugins = registry.plugins;
  if (plugins.length === 0 || hints.format !== undefined) return resolution;
  let best: { plugin: FormatPlugin; confidence: number } | undefined;
  for (const plugin of plugins) {
    budget.tick();
    if (hinted(plugin, hints) && (typeof plugin.detect !== 'function' || probe(plugin, bytes) > 0)) {
      best = { plugin, confidence: 0.95 };
      break;
    }
  }
  if (!best && resolution.result.confidence < CONFIDENT) {
    for (const plugin of plugins) {
      budget.tick();
      const confidence = probe(plugin, bytes);
      if (confidence > resolution.result.confidence && confidence > (best?.confidence ?? 0))
        best = { plugin, confidence };
    }
  }
  if (!best) return resolution;
  return {
    result: {
      format: best.plugin.id,
      mimeType: best.plugin.mimeTypes?.[0] ?? 'application/octet-stream',
      confidence: best.confidence,
    },
    ...(resolution.zip ? { zip: resolution.zip } : {}),
    ...(resolution.cfb ? { cfb: resolution.cfb } : {}),
  };
}
