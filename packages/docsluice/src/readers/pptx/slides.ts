import { Budget } from '../../core/budget.js';
import type { ReadContext } from '../../core/reader.js';
import type { Cell } from '../../core/model.js';
import { CorruptFileError, LimitExceededError } from '../../core/errors.js';
import type { OoxmlParts } from '../../ooxml/parts.js';
import { readRelationships } from '../../ooxml/rels.js';
import { scanXml } from '../../xml/index.js';
import type { XmlElement, XmlElementInfo } from '../../xml/index.js';
import {
  DRAWING_NS,
  IDENTITY_TRANSFORM,
  PRESENTATION_NS,
  applyTransform,
  directChild,
  directChildren,
  groupTransform,
  isElement,
  placeholderInfo,
  placeholderKey,
  shapePosition,
} from './geometry.js';
import {
  createTextStage,
  parseTextBody,
  readDrawingText,
  retainTextObject,
  toListItems,
  type TextStage,
} from './text.js';

const DIAGRAM_NS = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAX_RETAINED = 50_000;
const MAX_XML_OBJECTS = 500_000;
const MAX_XML_SOURCE_WORK = 20_000_000;

/** XML structure is necessary input, not emitted document text. Keep parsing budgeted
 * while applying a local source-work cap instead of spending outputChars on XML text. */
class StructuralXmlBudget extends Budget {
  #sourceWork = 0;

  constructor(private readonly parent: Budget) {
    super(parent.limits, { warnings: parent.warnings, signal: parent.signal, onLimit: 'throw' });
  }

  override tick(): void {
    this.parent.tick();
    if (++this.#sourceWork > MAX_XML_SOURCE_WORK)
      throw new LimitExceededError('pptxXmlSourceWork', MAX_XML_SOURCE_WORK);
  }

  override enterDepth(kind: 'xml' | 'block' | 'child'): boolean {
    return this.parent.enterDepth(kind);
  }

  override exitDepth(kind: 'xml' | 'block' | 'child'): void {
    this.parent.exitDepth(kind);
  }

  override checkOutputChars(amount: number): boolean {
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new LimitExceededError('pptxXmlText', MAX_XML_SOURCE_WORK);
    if (amount > MAX_XML_SOURCE_WORK) throw new LimitExceededError('pptxXmlText', MAX_XML_SOURCE_WORK);
    return true;
  }
}

export function createStructuralXmlBudget(parent: Budget): Budget {
  return new StructuralXmlBudget(parent);
}

function parseStructuralXml(bytes: Uint8Array, ctx: ReadContext, path: string): XmlElement | undefined {
  let root: XmlElement | undefined;
  const stack: XmlElement[] = [];
  let retained = 0;
  scanXml(
    bytes,
    {
      onOpen(_name: string, attrs: Map<string, string>, info: XmlElementInfo) {
        if (++retained > MAX_XML_OBJECTS) throw new LimitExceededError('pptxXmlObjects', MAX_XML_OBJECTS);
        const element: XmlElement = { ...info, attrs: new Map(attrs), children: [] };
        const parent = stack.at(-1);
        if (parent) parent.children.push(element);
        else if (!root) root = element;
        stack.push(element);
      },
      onText(text: string) {
        const parent = stack.at(-1);
        if (parent) parent.children.push(text);
      },
      onClose() {
        stack.pop();
      },
    },
    { budget: createStructuralXmlBudget(ctx.budget), warnings: ctx.warnings, path },
  );
  return root;
}

interface LocatedShape {
  element: XmlElement;
  x: number;
  y: number;
  order: number;
  placeholder?: { type: string; index: string };
}

interface LayoutPosition {
  x: number;
  y: number;
}

function partPath(ctx: ReadContext, part: string): string {
  return ctx.path ? `${ctx.path}/${part}` : part;
}

function slideLocation(ctx: ReadContext, part: string, slide: number) {
  return { slide, path: partPath(ctx, part) };
}

function warnUnreadable(ctx: ReadContext, part: string): void {
  ctx.warnings.add({
    code: 'UNREADABLE_PART',
    message: 'A PowerPoint slide part could not be read.',
    loc: { path: partPath(ctx, part) },
  });
}

async function xmlPart(parts: OoxmlParts, path: string, ctx: ReadContext): Promise<XmlElement | undefined> {
  const bytes = await parts.read(path);
  if (!bytes) return undefined;
  return parseStructuralXml(bytes, ctx, partPath(ctx, path));
}

interface NamespaceScope {
  parent?: NamespaceScope;
  declarations: Map<string, string>;
}

function namespaceValue(
  scope: NamespaceScope,
  prefix: string,
  budget: ReadContext['budget'],
): string | undefined {
  for (let current: NamespaceScope | undefined = scope; current; current = current.parent) {
    budget.tick();
    const value = current.declarations.get(prefix);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Collect relationship-namespace attributes without assuming their producer-chosen prefix. */
function relationshipAttributes(root: XmlElement, ctx: ReadContext): Map<XmlElement, Map<string, string>> {
  const references = new Map<XmlElement, Map<string, string>>();
  const stack: Array<{ element: XmlElement; parent?: NamespaceScope }> = [{ element: root }];
  let visited = 0;
  while (stack.length > 0) {
    ctx.budget.tick();
    if (++visited > MAX_RETAINED) throw new LimitExceededError('pptxObjects', MAX_RETAINED);
    const { element, parent } = stack.pop()!;
    const declarations = new Map<string, string>();
    for (const [name, value] of element.attrs) {
      ctx.budget.tick();
      if (name === 'xmlns') declarations.set('', value);
      else if (name.startsWith('xmlns:')) declarations.set(name.slice(6), value);
    }
    const scope = declarations.size ? { parent, declarations } : parent;
    if (scope) {
      let attributes: Map<string, string> | undefined;
      for (const [name, value] of element.attrs) {
        ctx.budget.tick();
        const colon = name.indexOf(':');
        if (colon <= 0) continue;
        const prefix = name.slice(0, colon);
        const localName = name.slice(colon + 1);
        if (namespaceValue(scope, prefix, ctx.budget) !== OFFICE_REL_NS) continue;
        attributes ??= new Map();
        attributes.set(localName, value);
      }
      if (attributes) references.set(element, attributes);
    }
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = element.children[index]!;
      if (typeof child === 'string') continue;
      if (stack.length >= MAX_RETAINED) throw new LimitExceededError('pptxObjects', MAX_RETAINED);
      stack.push({ element: child, parent: scope });
    }
  }
  return references;
}

function requiredChild(parent: XmlElement, ns: string, name: string, ctx: ReadContext): XmlElement {
  const found = directChild(parent, ns, name, ctx.budget);
  if (!found) throw new CorruptFileError('A required PowerPoint structure is missing.');
  return found;
}

function isGroup(element: XmlElement): boolean {
  return element.namespaceURI === PRESENTATION_NS && element.localName === 'grpSp';
}

function isShape(element: XmlElement): boolean {
  return (
    element.namespaceURI === PRESENTATION_NS &&
    (element.localName === 'sp' || element.localName === 'graphicFrame')
  );
}

function findTextBody(shape: XmlElement, ctx: ReadContext): XmlElement | undefined {
  return directChild(shape, PRESENTATION_NS, 'txBody', ctx.budget);
}

function textFromElement(element: XmlElement, ctx: ReadContext, stage: TextStage): string {
  const paragraphs = parseTextBody(element, ctx.budget, stage);
  let output = '';
  for (const paragraph of paragraphs) {
    ctx.budget.tick();
    if (output) output += '\n';
    output += paragraph.text;
  }
  return output;
}

function layoutPositions(layout: XmlElement, ctx: ReadContext): Map<string, LayoutPosition> {
  const output = new Map<string, LayoutPosition>();
  const stack: XmlElement[] = [layout];
  let visited = 0;
  while (stack.length > 0) {
    ctx.budget.tick();
    if (++visited > MAX_RETAINED) throw new LimitExceededError('pptxObjects', MAX_RETAINED);
    const element = stack.pop()!;
    if (element.namespaceURI === PRESENTATION_NS && element.localName === 'sp') {
      const placeholder = placeholderInfo(element, ctx.budget);
      const position = shapePosition(element, ctx.budget);
      if (placeholder && position) output.set(placeholderKey(placeholder.type, placeholder.index), position);
    }
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = element.children[index]!;
      if (typeof child !== 'string') {
        if (stack.length + visited >= MAX_RETAINED) throw new LimitExceededError('pptxObjects', MAX_RETAINED);
        stack.push(child);
      }
    }
  }
  return output;
}

function collectShapes(
  tree: XmlElement,
  inherited: Map<string, LayoutPosition>,
  ctx: ReadContext,
): LocatedShape[] {
  const result: LocatedShape[] = [];
  type Frame = { element: XmlElement; transform: typeof IDENTITY_TRANSFORM; exit?: false } | { exit: true };
  const stack: Frame[] = [];
  for (let index = tree.children.length - 1; index >= 0; index -= 1) {
    ctx.budget.tick();
    const child = tree.children[index]!;
    if (typeof child !== 'string') {
      if (stack.length >= MAX_RETAINED) throw new LimitExceededError('pptxObjects', MAX_RETAINED);
      stack.push({ element: child, transform: IDENTITY_TRANSFORM });
    }
  }
  let activeDepth = 0;
  let order = 0;
  let visited = 0;
  try {
    while (stack.length > 0) {
      ctx.budget.tick();
      const frame = stack.pop()!;
      if ('exit' in frame) {
        ctx.budget.exitDepth('block');
        activeDepth--;
        continue;
      }
      const { element, transform } = frame;
      if (++visited > MAX_RETAINED) throw new LimitExceededError('pptxObjects', MAX_RETAINED);
      if (isGroup(element)) {
        let entered: boolean;
        try {
          entered = ctx.budget.enterDepth('block');
        } catch (error) {
          ctx.budget.exitDepth('block');
          throw error;
        }
        if (!entered) {
          ctx.budget.exitDepth('block');
          continue;
        }
        activeDepth++;
        const nextTransform = groupTransform(element, transform, ctx.budget);
        stack.push({ exit: true });
        for (let index = element.children.length - 1; index >= 0; index -= 1) {
          ctx.budget.tick();
          const child = element.children[index]!;
          if (typeof child !== 'string') {
            if (stack.length + visited >= MAX_RETAINED)
              throw new LimitExceededError('pptxObjects', MAX_RETAINED);
            stack.push({ element: child, transform: nextTransform });
          }
        }
      } else if (isShape(element)) {
        if (result.length >= MAX_RETAINED) throw new LimitExceededError('pptxObjects', MAX_RETAINED);
        const placeholder = placeholderInfo(element, ctx.budget);
        let point = shapePosition(element, ctx.budget);
        if (point) point = applyTransform(point, transform);
        if (!point && placeholder) point = inherited.get(placeholderKey(placeholder.type, placeholder.index));
        result.push({
          element,
          x: point?.x ?? Number.MAX_SAFE_INTEGER,
          y: point?.y ?? Number.MAX_SAFE_INTEGER,
          order: order++,
          ...(placeholder ? { placeholder } : {}),
        });
      }
    }
  } finally {
    while (activeDepth > 0) {
      ctx.budget.exitDepth('block');
      activeDepth--;
    }
  }
  result.sort((left, right) => {
    ctx.budget.tick();
    return left.y - right.y || left.x - right.x || left.order - right.order;
  });
  return result;
}

function parseTable(
  shape: XmlElement,
  ctx: ReadContext,
  stage: TextStage,
): { rows: Cell[][]; headerRows: number } | undefined {
  const graphic = directChild(shape, DRAWING_NS, 'graphic', ctx.budget);
  const data = graphic ? directChild(graphic, DRAWING_NS, 'graphicData', ctx.budget) : undefined;
  const table = data ? directChild(data, DRAWING_NS, 'tbl', ctx.budget) : undefined;
  if (!table) return undefined;
  const properties = directChild(table, DRAWING_NS, 'tblPr', ctx.budget);
  const headerRows = properties?.attrs.get('firstRow') === '1' ? 1 : 0;
  const rows: Cell[][] = [];
  for (const row of directChildren(table, DRAWING_NS, 'tr', ctx.budget)) {
    if (stage.blocked) break;
    retainTextObject(stage);
    const cells: Cell[] = [];
    for (const cell of directChildren(row, DRAWING_NS, 'tc', ctx.budget)) {
      if (stage.blocked) break;
      if (!ctx.budget.addCells(1)) {
        stage.blocked = true;
        break;
      }
      retainTextObject(stage);
      const txBody = directChild(cell, DRAWING_NS, 'txBody', ctx.budget);
      cells.push({ text: txBody ? textFromElement(txBody, ctx, stage) : '' });
    }
    rows.push(cells);
  }
  return { rows, headerRows };
}

function emitTextShape(
  shape: LocatedShape,
  part: string,
  slideNumber: number,
  ctx: ReadContext,
  stage: TextStage,
): void {
  const body = findTextBody(shape.element, ctx);
  if (!body) return;
  const paragraphs = parseTextBody(body, ctx.budget, stage);
  let joined = '';
  for (const paragraph of paragraphs) {
    ctx.budget.tick();
    if (joined) joined += '\n';
    joined += paragraph.text;
  }
  if (!joined.trim()) return;
  const loc = slideLocation(ctx, part, slideNumber);
  const isBody = shape.placeholder?.type === 'body';
  let anyBullet = isBody;
  let ordered = false;
  let sawBullet = false;
  for (const paragraph of paragraphs) {
    ctx.budget.tick();
    if (paragraph.bullet) anyBullet = true;
    if (paragraph.bullet) {
      if (!sawBullet) ordered = paragraph.ordered;
      else if (!paragraph.ordered) ordered = false;
      sawBullet = true;
    }
  }
  if (anyBullet) ctx.out.list(ordered, toListItems(paragraphs, ctx.budget, stage), loc);
  else for (const paragraph of paragraphs) ctx.out.paragraph(paragraph.text, loc);
}

async function emitSmartArt(
  shape: XmlElement,
  rels: Map<string, { type: string; part?: string }>,
  relationshipIds: Map<XmlElement, Map<string, string>>,
  part: string,
  slideNumber: number,
  parts: OoxmlParts,
  ctx: ReadContext,
  stage: TextStage,
): Promise<void> {
  const graphic = directChild(shape, DRAWING_NS, 'graphic', ctx.budget);
  const data = graphic ? directChild(graphic, DRAWING_NS, 'graphicData', ctx.budget) : undefined;
  if (!data || data.attrs.get('uri') !== DIAGRAM_NS) return;
  const relIds = directChild(data, DIAGRAM_NS, 'relIds', ctx.budget);
  const id = relIds ? relationshipIds.get(relIds)?.get('dm') : undefined;
  const relationship = id ? rels.get(id) : undefined;
  if (!relationship?.part || !relationship.type.endsWith('/diagramData')) return;
  const root = await xmlPart(parts, relationship.part, ctx);
  if (!root) return;
  const texts: string[] = [];
  const stack: Array<{ element: XmlElement; inNode: boolean; inText: boolean }> = [
    { element: root, inNode: false, inText: false },
  ];
  let visited = 0;
  while (stack.length > 0 && !stage.blocked) {
    ctx.budget.tick();
    const frame = stack.pop()!;
    const element = frame.element;
    if (++visited > MAX_RETAINED) throw new LimitExceededError('pptxObjects', MAX_RETAINED);
    const inNode =
      frame.inNode ||
      (element.namespaceURI === DIAGRAM_NS &&
        element.localName === 'pt' &&
        element.attrs.get('type') === 'node');
    const inText = frame.inText || (element.namespaceURI === DIAGRAM_NS && element.localName === 't');
    if (inNode && inText && element.namespaceURI === DRAWING_NS && element.localName === 't') {
      const text = readDrawingText(element, ctx.budget, stage);
      if (text.trim()) {
        retainTextObject(stage);
        texts.push(text);
      }
    }
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = element.children[index]!;
      if (typeof child !== 'string') {
        if (stack.length + visited >= MAX_RETAINED) throw new LimitExceededError('pptxObjects', MAX_RETAINED);
        stack.push({ element: child, inNode, inText });
      }
    }
  }
  if (texts.length) {
    const items = [];
    for (const text of texts) {
      ctx.budget.tick();
      retainTextObject(stage);
      items.push({ text });
    }
    ctx.out.list(false, items, slideLocation(ctx, part, slideNumber));
  }
}

async function parseSlide(
  part: string,
  slideNumber: number,
  parts: OoxmlParts,
  ctx: ReadContext,
): Promise<boolean> {
  const slide = await xmlPart(parts, part, ctx);
  if (!slide || slide.namespaceURI !== PRESENTATION_NS || slide.localName !== 'sld') {
    warnUnreadable(ctx, part);
    return true;
  }
  const relationshipIds = relationshipAttributes(slide, ctx);
  const rels = await readRelationships(parts, part, {
    budget: createStructuralXmlBudget(ctx.budget),
    warnings: ctx.warnings,
    path: partPath(ctx, part),
  });
  const inherited = new Map<string, LayoutPosition>();
  for (const relationship of rels.values()) {
    ctx.budget.tick();
    if (relationship.type.endsWith('/slideLayout') && relationship.part) {
      const layout = await xmlPart(parts, relationship.part, ctx);
      if (layout) {
        const layoutRels = await readRelationships(parts, relationship.part, {
          budget: createStructuralXmlBudget(ctx.budget),
          warnings: ctx.warnings,
          path: partPath(ctx, relationship.part),
        });
        for (const masterRel of layoutRels.values()) {
          ctx.budget.tick();
          if (!masterRel.type.endsWith('/slideMaster') || !masterRel.part) continue;
          const master = await xmlPart(parts, masterRel.part, ctx);
          if (master) {
            const positions = layoutPositions(master, ctx);
            for (const entry of positions) {
              ctx.budget.tick();
              inherited.set(entry[0], entry[1]);
            }
          }
          break;
        }
        const positions = layoutPositions(layout, ctx);
        for (const entry of positions) {
          ctx.budget.tick();
          inherited.set(entry[0], entry[1]);
        }
      }
      break;
    }
  }
  const cSld = directChild(slide, PRESENTATION_NS, 'cSld', ctx.budget);
  const tree = cSld ? directChild(cSld, PRESENTATION_NS, 'spTree', ctx.budget) : undefined;
  if (!cSld || !tree) {
    warnUnreadable(ctx, part);
    return !ctx.budget.truncated;
  }
  const shapes = collectShapes(tree, inherited, ctx);
  const stage = createTextStage();
  let titleShape: LocatedShape | undefined;
  let titleText: string | undefined;
  for (const shape of shapes) {
    ctx.budget.tick();
    if (shape.placeholder?.type === 'title' || shape.placeholder?.type === 'ctrTitle') {
      const body = findTextBody(shape.element, ctx);
      if (body) {
        const paragraphs = parseTextBody(body, ctx.budget, stage);
        if (paragraphs.length === 0) continue;
        titleShape = shape;
        titleText = '';
        for (const paragraph of paragraphs) {
          ctx.budget.tick();
          if (titleText) titleText += '\n';
          titleText += paragraph.text;
        }
        break;
      }
    }
  }
  const loc = slideLocation(ctx, part, slideNumber);
  let opened: boolean | undefined;
  try {
    opened = ctx.out.openSection('slide', loc, titleText);
    if (!opened) return false;
    if (titleText) ctx.out.heading(1, titleText, loc);
    for (const shape of shapes) {
      ctx.budget.tick();
      if (shape === titleShape) continue;
      if (stage.blocked) break;
      if (shape.element.localName === 'graphicFrame') {
        const table = parseTable(shape.element, ctx, stage);
        if (table) ctx.out.table(table.rows, table.headerRows, loc);
        else await emitSmartArt(shape.element, rels, relationshipIds, part, slideNumber, parts, ctx, stage);
      } else {
        emitTextShape(shape, part, slideNumber, ctx, stage);
      }
    }
  } finally {
    if (opened !== undefined) ctx.out.closeSection();
  }
  return !ctx.budget.truncated;
}

export async function parseSlides(parts: OoxmlParts, ctx: ReadContext): Promise<void> {
  if (ctx.budget.truncated) return;
  const packageRelationships = await readRelationships(parts, '', {
    budget: createStructuralXmlBudget(ctx.budget),
    warnings: ctx.warnings,
    path: ctx.path,
  });
  let presentationPart: string | undefined;
  for (const relationship of packageRelationships.values()) {
    ctx.budget.tick();
    if (relationship.type.endsWith('/officeDocument') && relationship.part) {
      presentationPart = relationship.part;
      break;
    }
  }
  if (!presentationPart)
    throw new CorruptFileError('The PowerPoint office document relationship is missing.');
  const presentation = await xmlPart(parts, presentationPart, ctx);
  if (
    !presentation ||
    presentation.namespaceURI !== PRESENTATION_NS ||
    presentation.localName !== 'presentation'
  ) {
    throw new CorruptFileError('The PowerPoint presentation part is missing or invalid.');
  }
  const relationships = await readRelationships(parts, presentationPart, {
    budget: createStructuralXmlBudget(ctx.budget),
    warnings: ctx.warnings,
    path: partPath(ctx, presentationPart),
  });
  const relationshipIds = relationshipAttributes(presentation, ctx);
  const list = requiredChild(presentation, PRESENTATION_NS, 'sldIdLst', ctx);
  let slideNumber = 0;
  let validRelationships = 0;
  for (const child of list.children) {
    ctx.budget.tick();
    if (!isElement(child, PRESENTATION_NS, 'sldId')) continue;
    slideNumber++;
    const id = relationshipIds.get(child)?.get('id');
    const relationship = id ? relationships.get(id) : undefined;
    if (!relationship?.part || !relationship.type.endsWith('/slide')) {
      warnUnreadable(ctx, presentationPart);
      continue;
    }
    validRelationships++;
    if (!(await parseSlide(relationship.part, slideNumber, parts, ctx))) break;
  }
  if (validRelationships === 0)
    throw new CorruptFileError('The PowerPoint presentation contains no readable slides.');
}
