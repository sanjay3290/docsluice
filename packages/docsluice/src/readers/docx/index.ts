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
import { readDocxNotes, readDocxStoryText } from './stories.js';
import type { DocxNoteText } from './stories.js';
import type { DocxNoteRef } from './body.js';
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
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const NOTE_PARTS = [
  ['footnote', 'footnotes'],
  ['endnote', 'endnotes'],
  ['comment', 'comments'],
] as const;

interface StoryPart {
  path: string;
  text: string;
}

/** Header and footer parts by relationship id, read before the synchronous body scan. */
async function readStories(
  parts: OoxmlParts,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
  ctx: XmlContext,
  pathPrefix: string,
): Promise<Map<string, StoryPart>> {
  const stories = new Map<string, StoryPart>();
  for (const [id, relationship] of relationships) {
    ctx.budget.tick();
    if (relationship.external || !relationship.part) continue;
    if (relationship.type !== `${REL_BASE}header` && relationship.type !== `${REL_BASE}footer`) continue;
    const bytes = await parts.read(relationship.part);
    if (!bytes) continue;
    const path = pathWithPrefix(pathPrefix, relationship.part);
    stories.set(id, {
      path,
      text: readDocxStoryText(bytes, { budget: ctx.budget, warnings: ctx.warnings, path }),
    });
  }
  return stories;
}

/** Footnotes, endnotes and comments by role and `w:id`, with the path of the part they came from. */
async function readNotes(
  parts: OoxmlParts,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
  ctx: XmlContext,
  pathPrefix: string,
): Promise<Map<string, { path: string; notes: Map<string, DocxNoteText> }>> {
  const result = new Map<string, { path: string; notes: Map<string, DocxNoteText> }>();
  for (const [role, part] of NOTE_PARTS) {
    ctx.budget.tick();
    const relationship = relationshipOfType(relationships, `${REL_BASE}${part}`, ctx);
    if (!relationship || relationship.external || !relationship.part) continue;
    const bytes = await parts.read(relationship.part);
    if (!bytes) continue;
    const path = pathWithPrefix(pathPrefix, relationship.part);
    result.set(role, {
      path,
      notes: readDocxNotes(bytes, { budget: ctx.budget, warnings: ctx.warnings, path }, role),
    });
  }
  return result;
}

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
    const stories = await readStories(parts, mainRelationships, xmlContext, ctx.path);
    const notes = await readNotes(parts, mainRelationships, xmlContext, ctx.path);
    const emittedNotes = new Set<string>();
    const emitNotes = (refs: readonly DocxNoteRef[]): void => {
      for (const ref of refs) {
        ctx.budget.tick();
        const key = `${ref.role}:${ref.id}`;
        const source = notes.get(ref.role);
        const note = source?.notes.get(ref.id);
        if (!source || !note || emittedNotes.has(key)) continue;
        emittedNotes.add(key);
        ctx.out.note(ref.role, note.text, { path: source.path }, note.author);
      }
    };
    // Each referenced header and footer is emitted once per distinct text: headers before the body,
    // footers after it.
    const sectionStories: Array<{ kind: 'header' | 'footer'; id: string }> = [];
    const emitStories = (kind: 'header' | 'footer'): void => {
      const seen = new Set<string>();
      for (const reference of sectionStories) {
        ctx.budget.tick();
        const story = reference.kind === kind ? stories.get(reference.id) : undefined;
        if (!story || story.text.length === 0 || seen.has(story.text)) continue;
        seen.add(story.text);
        ctx.out.headerFooter(kind, story.text, { path: story.path });
      }
    };
    const lists = new DocxLists(ctx, numbering, styles, emitNotes);
    scanDocxBody(
      main.bytes,
      { ...ctx, path: pathWithPrefix(ctx.path, main.path) },
      styles,
      mainRelationships,
      {
        onParagraph: (paragraph) => lists.accept(paragraph),
        onTable: () => lists.flush(),
        onNotes: emitNotes,
        onSectionReference: (kind, id) => sectionStories.push({ kind, id }),
        beforeEmit: () => emitStories('header'),
      },
    );
    lists.flush();
    emitStories('footer');
  },
};
