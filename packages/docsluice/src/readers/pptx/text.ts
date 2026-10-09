import type { Budget } from '../../core/budget.js';
import { LimitExceededError } from '../../core/errors.js';
import type { ListItem } from '../../core/model.js';
import type { XmlElement } from '../../xml/index.js';
import { DRAWING_NS, directChild, isElement } from './geometry.js';

const MAX_TEXT_CHARS = 5_000_000;
const MAX_RETAINED_OBJECTS = 50_000;

export interface TextStage {
  pendingChars: number;
  totalChars: number;
  objects: number;
  blocked: boolean;
}

export function createTextStage(): TextStage {
  return { pendingChars: 0, totalChars: 0, objects: 0, blocked: false };
}

export function retainTextObject(stage: TextStage): void {
  if (++stage.objects > MAX_RETAINED_OBJECTS)
    throw new LimitExceededError('pptxObjects', MAX_RETAINED_OBJECTS);
}

function stageText(text: string, budget: Budget, stage: TextStage, paragraphChars: number): boolean {
  if (stage.totalChars + text.length > MAX_TEXT_CHARS)
    throw new LimitExceededError('pptxTextChars', MAX_TEXT_CHARS);
  if (paragraphChars + text.length > MAX_TEXT_CHARS)
    throw new LimitExceededError('pptxTextChars', MAX_TEXT_CHARS);
  if (!budget.checkOutputChars(stage.pendingChars + text.length)) {
    stage.blocked = true;
    return false;
  }
  stage.pendingChars += text.length;
  stage.totalChars += text.length;
  return true;
}

export interface TextParagraph {
  text: string;
  level: number;
  bullet: boolean;
  ordered: boolean;
}

export function readDrawingText(element: XmlElement, budget: Budget, stage: TextStage): string {
  if (element.namespaceURI !== DRAWING_NS || element.localName !== 't') return '';
  let text = '';
  for (const child of element.children) {
    budget.tick();
    if (typeof child === 'string') {
      if (!stageText(child, budget, stage, text.length)) break;
      text += child;
    }
  }
  return text;
}

function paragraphText(paragraph: XmlElement, budget: Budget, stage: TextStage): string {
  const chunks: string[] = [];
  let paragraphChars = 0;
  for (const item of paragraph.children) {
    budget.tick();
    if (typeof item === 'string' || item.namespaceURI !== DRAWING_NS) continue;
    if (item.localName === 'br') {
      if (!stageText('\n', budget, stage, paragraphChars)) break;
      paragraphChars += 1;
      chunks.push('\n');
      continue;
    }
    if (item.localName !== 'r' && item.localName !== 'fld') continue;
    for (const runChild of item.children) {
      budget.tick();
      if (!isElement(runChild, DRAWING_NS, 't')) continue;
      for (const text of runChild.children) {
        budget.tick();
        if (typeof text !== 'string') continue;
        if (!stageText(text, budget, stage, paragraphChars)) break;
        paragraphChars += text.length;
        chunks.push(text);
      }
      if (stage.blocked) break;
    }
    if (stage.blocked) break;
  }
  return chunks.join('');
}

function paragraphInfo(paragraph: XmlElement, budget: Budget): Omit<TextParagraph, 'text'> {
  const properties = directChild(paragraph, DRAWING_NS, 'pPr', budget);
  const rawLevel = properties?.attrs.get('lvl');
  const level = rawLevel && /^\d+$/.test(rawLevel) ? Math.min(8, Number(rawLevel)) : 0;
  let bullet = false;
  let ordered = false;
  if (properties) {
    for (const child of properties.children) {
      budget.tick();
      if (typeof child === 'string' || child.namespaceURI !== DRAWING_NS) continue;
      if (child.localName === 'buChar' || child.localName === 'buAutoNum') {
        bullet = true;
        ordered = child.localName === 'buAutoNum';
      } else if (child.localName === 'buNone') {
        bullet = false;
      }
    }
  }
  return { level, bullet, ordered };
}

export function parseTextBody(body: XmlElement, budget: Budget, stage = createTextStage()): TextParagraph[] {
  const output: TextParagraph[] = [];
  for (const child of body.children) {
    budget.tick();
    if (stage.blocked) break;
    if (!isElement(child, DRAWING_NS, 'p')) continue;
    const info = paragraphInfo(child, budget);
    const text = paragraphText(child, budget, stage);
    if (text.trim()) {
      retainTextObject(stage);
      output.push({ text, ...info });
    }
  }
  return output;
}

export function toListItems(paragraphs: TextParagraph[], budget: Budget, stage?: TextStage): ListItem[] {
  const root: ListItem[] = [];
  const levels: ListItem[][] = [root];
  for (const paragraph of paragraphs) {
    budget.tick();
    if (stage) retainTextObject(stage);
    const level = Math.min(8, paragraph.level);
    while (levels.length <= level) {
      const parent = levels.at(-1)!;
      const last = parent.at(-1);
      if (!last) {
        levels.push(levels.at(-1)!);
      } else {
        last.items ??= [];
        levels.push(last.items);
      }
    }
    levels.length = level + 1;
    levels[level]!.push({
      text: paragraph.text,
      ...(paragraph.bullet ? { marker: paragraph.ordered ? '1.' : '•' } : {}),
    });
  }
  return root;
}
