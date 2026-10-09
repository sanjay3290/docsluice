import type { Features } from '../core/model.js';
import { EncryptedError } from '../core/errors.js';
import type { Budget } from '../core/budget.js';
import type { XmlContext } from '../xml/index.js';
import type { CfbArchive } from '../ole/index.js';
import type { ZipArchive } from '../zip/index.js';
import type { OoxmlParts } from './parts.js';
import { readRelationships } from './rels.js';

export async function scanFeatures(
  parts: OoxmlParts,
  archive: ZipArchive,
  ctx: XmlContext,
): Promise<Features> {
  const features: Features = {
    hasMacros: false,
    hasExternalLinks: false,
    hasEmbeddedFiles: false,
    isEncrypted: false,
    hasJavaScript: false,
  };
  for (const entry of archive.entries) {
    ctx.budget.tick();
    let name = '';
    for (let index = 0; index < entry.name.length; index += 1) {
      ctx.budget.tick();
      const code = entry.name.charCodeAt(index);
      name += String.fromCharCode(code >= 65 && code <= 90 ? code + 32 : code);
    }
    if (name.endsWith('/vbaproject.bin') || name === 'vbaproject.bin') features.hasMacros = true;
    if (name.includes('/embeddings/') || name.startsWith('embeddings/')) features.hasEmbeddedFiles = true;
    if (name.endsWith('.rels')) {
      const source = name === '_rels/.rels' ? '' : relationshipSource(entry.name);
      if (source === undefined) continue;
      const relationships = await readRelationships(parts, source, ctx);
      for (const relationship of relationships.values()) {
        ctx.budget.tick();
        if (relationship.external) features.hasExternalLinks = true;
      }
    }
  }
  if (features.hasMacros) {
    ctx.warnings.add({
      code: 'MACROS_PRESENT',
      message: 'The document contains macros; they were not executed.',
    });
  }
  return features;
}

function relationshipSource(path: string): string | undefined {
  const marker = '/_rels/';
  const index = path.toLowerCase().lastIndexOf(marker);
  if (!path.toLowerCase().endsWith('.rels')) return undefined;
  if (index < 0) {
    if (!path.toLowerCase().startsWith('_rels/')) return undefined;
    return path.slice('_rels/'.length, -'.rels'.length);
  }
  return `${path.slice(0, index + 1)}${path.slice(index + marker.length, -5)}`;
}

/** Reject encrypted Office CFB containers before a caller attempts to open embedded ZIP data. */
export function rejectEncryptedOffice(cfb: CfbArchive, budget: Budget): void {
  for (const entry of cfb.entries) {
    budget.tick();
    let name = '';
    for (let index = 0; index < entry.path.length; index += 1) {
      budget.tick();
      const code = entry.path.charCodeAt(index);
      name += String.fromCharCode(code >= 65 && code <= 90 ? code + 32 : code);
    }
    if (entry.type === 'stream' && name === 'encryptedpackage') {
      throw new EncryptedError('password-required');
    }
  }
}
