import type { Reader, ReadContext } from '../../core/reader.js';
import {
  OoxmlParts,
  readContentTypes,
  readProperties,
  readRelationships,
  scanFeatures,
} from '../../ooxml/index.js';
import type { OoxmlRelationship } from '../../ooxml/index.js';
import { openZip } from '../../zip/index.js';
import type { XmlContext } from '../../xml/index.js';
import { scanDocxBody } from './body.js';
import { DocxLists } from './lists.js';
import { parseDocxNumbering } from './numbering.js';
import type { DocxNumbering } from './numbering.js';
import { parseDocxStyles } from './styles.js';
import type { DocxStyle } from './styles.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAIN_PART_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const OFFICE_DOCUMENT_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const STYLES_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';
const NUMBERING_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';

function warnUnreadable(ctx: XmlContext, message: string): void {
  ctx.warnings.add({ code: 'UNREADABLE_PART', message });
}

function pathWithPrefix(prefix: string, part: string): string {
  return prefix ? `${prefix}/${part}` : part;
}

function relationshipOfType<T extends { type: string }>(
  relationships: ReadonlyMap<string, T>,
  type: string,
  ctx: XmlContext,
): T | undefined {
  for (const relationship of relationships.values()) {
    ctx.budget.tick();
    if (relationship.type === type) return relationship;
  }
  return undefined;
}

async function readOptionalStyles(
  parts: OoxmlParts,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
  ctx: XmlContext,
  pathPrefix: string,
): Promise<Map<string, DocxStyle>> {
  const styleRelationship = relationshipOfType(relationships, STYLES_REL, ctx);
  const fallbackPath = 'word/styles.xml';
  const candidate = styleRelationship && !styleRelationship.external ? styleRelationship.part : undefined;
  let path = candidate ?? fallbackPath;
  let bytes = path ? await parts.read(path) : undefined;
  if (!bytes && candidate !== undefined && candidate !== fallbackPath) {
    path = fallbackPath;
    bytes = await parts.read(path);
  }
  if (!bytes) return new Map();
  const styleContext: XmlContext = {
    budget: ctx.budget,
    warnings: ctx.warnings,
    path: pathWithPrefix(pathPrefix, path),
  };
  return parseDocxStyles(bytes, styleContext);
}

async function readOptionalNumbering(
  parts: OoxmlParts,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
  ctx: XmlContext,
  pathPrefix: string,
): Promise<DocxNumbering> {
  const relationship = relationshipOfType(relationships, NUMBERING_REL, ctx);
  const candidate = relationship && !relationship.external ? relationship.part : undefined;
  let path = candidate ?? 'word/numbering.xml';
  let bytes = await parts.read(path);
  if (!bytes && path !== 'word/numbering.xml') {
    path = 'word/numbering.xml';
    bytes = await parts.read(path);
  }
  if (!bytes) return new Map();
  return parseDocxNumbering(bytes, {
    budget: ctx.budget,
    warnings: ctx.warnings,
    path: pathWithPrefix(pathPrefix, path),
  });
}

async function readMainPart(
  parts: OoxmlParts,
  ctx: XmlContext,
): Promise<{ path: string; bytes: Uint8Array } | undefined> {
  const rootRelationships = await readRelationships(parts, '', ctx);
  const officeDocument = relationshipOfType(rootRelationships, OFFICE_DOCUMENT_REL, ctx);
  const candidates: string[] = [];
  if (officeDocument && !officeDocument.external && officeDocument.part) candidates.push(officeDocument.part);
  if (!candidates.includes('word/document.xml')) candidates.push('word/document.xml');
  for (const path of candidates) {
    ctx.budget.tick();
    const bytes = await parts.read(path);
    if (bytes) return { path, bytes };
  }
  return undefined;
}

/** Reader for WordprocessingML `.docx` packages. */
export const docxReader: Reader = {
  id: 'docx',
  mimeTypes: [DOCX_MIME],
  async read(ctx: ReadContext): Promise<void> {
    const archive = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
    const xmlContext: XmlContext = {
      budget: ctx.budget,
      warnings: ctx.warnings,
      ...(ctx.path ? { path: ctx.path } : {}),
    };
    const parts = new OoxmlParts(archive, xmlContext);
    const contentTypes = await readContentTypes(parts, xmlContext);
    const main = await readMainPart(parts, xmlContext);
    if (!main) {
      warnUnreadable(xmlContext, 'The Word document body part could not be read.');
      return;
    }
    const mainType = contentTypes.mimeType(main.path);
    if (mainType !== undefined && mainType !== MAIN_PART_TYPE) {
      ctx.warnings.add({
        code: 'FORMAT_MISMATCH',
        message: 'The DOCX main part has an unexpected content type.',
      });
    }

    const mainContext: XmlContext = {
      budget: ctx.budget,
      warnings: ctx.warnings,
      path: pathWithPrefix(ctx.path, main.path),
    };
    const mainRelationships = await readRelationships(parts, main.path, mainContext);
    const styles = await readOptionalStyles(parts, mainRelationships, xmlContext, ctx.path);
    const numbering = await readOptionalNumbering(parts, mainRelationships, xmlContext, ctx.path);
    // Ancillary XML must be staged before body blocks charge the shared output
    // allowance; otherwise source text in a later part is counted on top of it.
    const metadata = await readProperties(parts, mainContext, ctx.options.metadata);
    ctx.out.setMetadata(metadata);
    const features = await scanFeatures(parts, archive, xmlContext);
    if (features.hasMacros) ctx.out.setFeature('hasMacros');
    if (features.hasExternalLinks) ctx.out.setFeature('hasExternalLinks');
    if (features.hasEmbeddedFiles) ctx.out.setFeature('hasEmbeddedFiles');
    if (features.isEncrypted) ctx.out.setFeature('isEncrypted');
    if (features.hasJavaScript) ctx.out.setFeature('hasJavaScript');
    const lists = new DocxLists(ctx, numbering, styles);
    scanDocxBody(
      main.bytes,
      { ...ctx, path: pathWithPrefix(ctx.path, main.path) },
      styles,
      mainRelationships,
      (paragraph) => lists.accept(paragraph),
      () => lists.flush(),
    );
    lists.flush();
  },
};
