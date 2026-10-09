import type { Budget } from '../../core/budget.js';
import { LimitExceededError } from '../../core/errors.js';
import type { XmlElement } from '../../xml/tree.js';

const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const MAX_NOTE_OBJECTS = 50_000;
const MAX_NOTE_CHARS = 5_000_000;

interface NoteStage {
  objects: number;
  chars: number;
  reservedOutputChars: number;
}

interface ParagraphMeasure {
  chars: number;
}

/** Read speaker-note text only from body placeholders in the notes shape tree. */
export function parseSpeakerNotes(root: XmlElement, budget: Budget): string[] {
  if (root.namespaceURI !== PRESENTATION_NS || root.localName !== 'notes') return [];

  const stage: NoteStage = { objects: 0, chars: 0, reservedOutputChars: 0 };
  preflightSource(root, budget, stage);

  const commonSlide = directChild(root, PRESENTATION_NS, 'cSld', budget);
  const shapeTree = commonSlide ? directChild(commonSlide, PRESENTATION_NS, 'spTree', budget) : undefined;
  if (!shapeTree) return [];

  const notes: string[] = [];
  let outputBlocked = false;
  for (const shape of directChildren(shapeTree, PRESENTATION_NS, 'sp', budget)) {
    budget.tick();
    if (!isBodyPlaceholder(shape, budget)) continue;
    const textBody = directChild(shape, PRESENTATION_NS, 'txBody', budget);
    if (!textBody) continue;

    const paragraphs: string[] = [];
    for (const paragraph of directChildren(textBody, DRAWING_NS, 'p', budget)) {
      budget.tick();
      const measure = measureParagraph(paragraph, budget);
      if (measure.chars === 0) continue;
      const separatorChars = paragraphs.length === 0 ? 0 : 1;
      const paragraphTotal = separatorChars + measure.chars;
      if (
        !Number.isSafeInteger(paragraphTotal) ||
        !budget.checkOutputChars(stage.reservedOutputChars + paragraphTotal)
      ) {
        outputBlocked = true;
        break;
      }
      paragraphs.push(collectParagraph(paragraph, budget));
      stage.reservedOutputChars += paragraphTotal;
    }

    if (paragraphs.length > 0) {
      // Join only after all retained paragraphs have passed the output preflight.
      notes.push(paragraphs.join('\n'));
    }
    if (outputBlocked) break;
    budget.tick();
  }
  return notes;
}

/** A false lexical value on p:sld means the presentation marks the slide hidden. */
export function slideIsHidden(root: XmlElement): boolean {
  if (root.namespaceURI !== PRESENTATION_NS || root.localName !== 'sld') return false;
  const show = root.attrs.get('show');
  return show === '0' || show === 'false';
}

/** Bound all source tree objects and characters before staging retained note strings. */
function preflightSource(root: XmlElement, budget: Budget, stage: NoteStage): void {
  const stack: XmlElement[] = [];
  reserveObject(stage);
  stack.push(root);
  while (stack.length > 0) {
    budget.tick();
    const element = stack.pop()!;
    addSourceChars(
      stage,
      element.name.length + element.localName.length + (element.namespaceURI?.length ?? 0),
    );
    for (const [name, value] of element.attrs) {
      budget.tick();
      reserveObject(stage);
      addSourceChars(stage, name.length + value.length);
    }
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      budget.tick();
      const child = element.children[index]!;
      reserveObject(stage);
      if (typeof child === 'string') addSourceChars(stage, child.length);
      else stack.push(child);
    }
  }
}

function reserveObject(stage: NoteStage): void {
  if (++stage.objects > MAX_NOTE_OBJECTS) throw new LimitExceededError('pptxObjects', MAX_NOTE_OBJECTS);
}

function addSourceChars(stage: NoteStage, amount: number): void {
  stage.chars += amount;
  if (!Number.isSafeInteger(stage.chars) || stage.chars > MAX_NOTE_CHARS)
    throw new LimitExceededError('pptxNoteChars', MAX_NOTE_CHARS);
}

function isBodyPlaceholder(shape: XmlElement, budget: Budget): boolean {
  const nonVisual = directChild(shape, PRESENTATION_NS, 'nvSpPr', budget);
  const nonVisualProperties = nonVisual ? directChild(nonVisual, PRESENTATION_NS, 'nvPr', budget) : undefined;
  const placeholder = nonVisualProperties
    ? directChild(nonVisualProperties, PRESENTATION_NS, 'ph', budget)
    : undefined;
  return placeholder?.attrs.get('type') === 'body';
}

function measureParagraph(paragraph: XmlElement, budget: Budget): ParagraphMeasure {
  let chars = 0;
  for (const item of paragraph.children) {
    budget.tick();
    if (typeof item === 'string' || item.namespaceURI !== DRAWING_NS) continue;
    if (item.localName === 'br') {
      chars += 1;
      continue;
    }
    if (item.localName !== 'r' && item.localName !== 'fld') continue;
    for (const runChild of item.children) {
      budget.tick();
      if (typeof runChild === 'string' || runChild.namespaceURI !== DRAWING_NS || runChild.localName !== 't')
        continue;
      for (const text of runChild.children) {
        budget.tick();
        if (typeof text === 'string') chars += text.length;
      }
    }
  }
  if (!Number.isSafeInteger(chars)) throw new LimitExceededError('pptxNoteChars', MAX_NOTE_CHARS);
  return { chars };
}

function collectParagraph(paragraph: XmlElement, budget: Budget): string {
  const chunks: string[] = [];
  for (const item of paragraph.children) {
    budget.tick();
    if (typeof item === 'string' || item.namespaceURI !== DRAWING_NS) continue;
    if (item.localName === 'br') {
      chunks.push('\n');
      continue;
    }
    if (item.localName !== 'r' && item.localName !== 'fld') continue;
    for (const runChild of item.children) {
      budget.tick();
      if (typeof runChild === 'string' || runChild.namespaceURI !== DRAWING_NS || runChild.localName !== 't')
        continue;
      for (const text of runChild.children) {
        budget.tick();
        if (typeof text === 'string') chunks.push(text);
      }
    }
  }
  return chunks.join('');
}

function directChild(
  parent: XmlElement,
  namespaceURI: string,
  localName: string,
  budget: Budget,
): XmlElement | undefined {
  for (const child of parent.children) {
    budget.tick();
    if (typeof child !== 'string' && child.namespaceURI === namespaceURI && child.localName === localName)
      return child;
  }
  return undefined;
}

function* directChildren(
  parent: XmlElement,
  namespaceURI: string,
  localName: string,
  budget: Budget,
): Generator<XmlElement> {
  for (const child of parent.children) {
    budget.tick();
    if (typeof child !== 'string' && child.namespaceURI === namespaceURI && child.localName === localName)
      yield child;
  }
}
