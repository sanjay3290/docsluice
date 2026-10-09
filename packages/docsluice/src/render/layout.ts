import type { Block, DocsluiceDocument, ListItem, SectionBlock } from '../core/model.js';
import type { Budget } from '../core/budget.js';
import { LimitExceededError } from '../core/errors.js';

export interface TextOptions {
  /** Include extracted child documents, preceded by their path. Defaults to false; enabling this shifts following offsets. */
  children?: boolean;
}

export type LayoutEvent =
  | { type: 'text'; text: string; block?: Block }
  | { type: 'start-section'; block: SectionBlock }
  | { type: 'end-section'; block: SectionBlock };

interface BlockFrame {
  blocks: Block[];
  index: number;
  section?: SectionBlock;
  entered: boolean;
}

interface DocumentFrame {
  document: DocsluiceDocument;
  childIndex: number;
  yieldedRoot: boolean;
  enteredChild: boolean;
}

/**
 * Walk document blocks in rendering order and yield their text with block identity.
 * Sections contribute only their descendants. Child documents are optional.
 */
export function* layout(
  document: DocsluiceDocument,
  options: TextOptions = {},
  budget?: Budget,
  enforceLimits = false,
): Generator<LayoutEvent> {
  let hasOutput = false;
  const activeDocuments = new WeakSet<DocsluiceDocument>([document]);
  const documents: DocumentFrame[] = [{ document, childIndex: 0, yieldedRoot: false, enteredChild: false }];
  const blockFrames: BlockFrame[] = [];
  try {
    while (documents.length > 0) {
      budget?.tick();
      const documentFrame = documents[documents.length - 1]!;
      if (!documentFrame.yieldedRoot) {
        documentFrame.yieldedRoot = true;
        blockFrames.push({ blocks: documentFrame.document.blocks, index: 0, entered: false });
      }

      while (blockFrames.length > 0) {
        budget?.tick();
        const frame = blockFrames[blockFrames.length - 1]!;
        if (frame.index >= frame.blocks.length) {
          blockFrames.pop();
          if (frame.entered) budget?.exitDepth('block');
          if (frame.section) yield { type: 'end-section', block: frame.section };
          continue;
        }
        if (frame.index > 0) {
          hasOutput = true;
          yield textEvent('\n\n', undefined, budget, enforceLimits);
        }
        const block = frame.blocks[frame.index++]!;
        if (block.kind === 'section') {
          if (enforceLimits) enterBlockDepth(budget);
          blockFrames.push({ blocks: block.blocks, index: 0, section: block, entered: enforceLimits });
          yield { type: 'start-section', block };
        } else {
          const text = renderBlock(block, budget, enforceLimits);
          if (text.length > 0) hasOutput = true;
          yield textEvent(text, block, budget, enforceLimits);
        }
      }

      if (options.children !== true || documentFrame.childIndex >= documentFrame.document.children.length) {
        documents.pop();
        activeDocuments.delete(documentFrame.document);
        if (documentFrame.enteredChild) budget?.exitDepth('child');
        continue;
      }
      const child = documentFrame.document.children[documentFrame.childIndex++]!;
      if (!child.document) continue;
      if (activeDocuments.has(child.document)) throw new TypeError('Child document cycle detected.');
      let enteredChild = false;
      if (enforceLimits && budget) {
        let canEnterChild: boolean;
        try {
          canEnterChild = budget.enterDepth('child');
        } catch (error) {
          budget.exitDepth('child');
          throw error;
        }
        if (!canEnterChild) {
          budget.exitDepth('child');
          throw new LimitExceededError('childDepth', budget.limits.childDepth);
        }
        enteredChild = true;
      }
      activeDocuments.add(child.document);
      documents.push({ document: child.document, childIndex: 0, yieldedRoot: false, enteredChild });
      if (hasOutput) {
        hasOutput = true;
        yield textEvent('\n\n', undefined, budget, enforceLimits);
      }
      if (child.path.length > 0) hasOutput = true;
      yield textEvent(child.path, undefined, budget, enforceLimits);
      hasOutput = true;
      yield textEvent('\n', undefined, budget, enforceLimits);
    }
  } finally {
    while (blockFrames.length > 0) {
      const frame = blockFrames.pop()!;
      if (frame.entered) budget?.exitDepth('block');
    }
    while (documents.length > 0) {
      const frame = documents.pop()!;
      activeDocuments.delete(frame.document);
      if (frame.enteredChild) budget?.exitDepth('child');
    }
  }
}

function textEvent(
  text: string,
  block: Block | undefined,
  budget: Budget | undefined,
  enforceLimits: boolean,
): LayoutEvent {
  if (enforceLimits) chargeOutput(budget, text.length);
  return block ? { type: 'text', text, block } : { type: 'text', text };
}

function enterBlockDepth(budget: Budget | undefined): void {
  if (!budget) return;
  try {
    if (!budget.enterDepth('block')) throw new RangeError('Document block nesting exceeded its limit.');
  } catch (error) {
    budget.exitDepth('block');
    throw error;
  }
}

function chargeOutput(budget: Budget | undefined, amount: number): void {
  if (!budget) throw new Error('A rendering budget is required when renderer limits are enabled.');
  if (!budget.addOutputChars(amount)) throw new RangeError('Rendered text exceeded its output limit.');
}

function renderBlock(
  block: Exclude<Block, SectionBlock>,
  budget: Budget | undefined,
  enforceLimits: boolean,
): string {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
    case 'code':
    case 'note':
    case 'header':
    case 'footer':
      if (enforceLimits) checkOutput(budget, block.text.length);
      return block.text;
    case 'image':
      if (enforceLimits && block.alt !== undefined) checkOutput(budget, block.alt.length);
      return block.alt ?? '';
    case 'table': {
      const lines: string[] = [];
      let length = 0;
      if (block.caption !== undefined) {
        length = appendLength(length, block.caption.length, lines.length > 0, budget, enforceLimits);
        lines.push(block.caption);
      }
      for (const row of block.rows) {
        budget?.tick();
        const cells: string[] = [];
        let rowLength = 0;
        for (const cell of row) {
          budget?.tick();
          if (enforceLimits) {
            if (!budget!.addCells(1)) throw new RangeError('Rendered table exceeded its cell limit.');
            rowLength = appendLength(rowLength, cell.text.length, cells.length > 0, budget, true);
          }
          cells.push(cell.text);
        }
        length = appendLength(length, rowLength, lines.length > 0, budget, enforceLimits);
        lines.push(cells.join('\t'));
      }
      return lines.join('\n');
    }
    case 'list':
      return renderList(block.ordered, block.items, budget, enforceLimits);
  }
}

function checkOutput(budget: Budget | undefined, amount: number): void {
  if (budget && !budget.checkOutputChars(amount))
    throw new RangeError('Rendered text exceeded its output limit.');
}

function appendLength(
  current: number,
  addition: number,
  withSeparator: boolean,
  budget: Budget | undefined,
  enforceLimits: boolean,
  separatorLength = 1,
): number {
  const next = current + addition + (withSeparator ? separatorLength : 0);
  if (enforceLimits) checkOutput(budget, next);
  return next;
}

function renderList(
  ordered: boolean,
  items: ListItem[],
  budget: Budget | undefined,
  enforceLimits: boolean,
): string {
  const lines: string[] = [];
  const stack: Array<{ items: ListItem[]; index: number; depth: number }> = [];
  if (enforceLimits) enterBlockDepth(budget);
  stack.push({ items, index: 0, depth: 0 });
  let length = 0;
  try {
    while (stack.length > 0) {
      budget?.tick();
      const frame = stack[stack.length - 1]!;
      if (frame.index >= frame.items.length) {
        stack.pop();
        if (enforceLimits) budget?.exitDepth('block');
        continue;
      }
      const itemIndex = frame.index++;
      const item = frame.items[itemIndex]!;
      const fallback = ordered ? `${itemIndex + 1}.` : '•';
      const marker = item.marker ?? fallback;
      const lineLength = frame.depth * 2 + marker.length + 1 + item.text.length;
      length = appendLength(length, lineLength, lines.length > 0, budget, enforceLimits);
      lines.push(`${'  '.repeat(frame.depth)}${marker} ${item.text}`);
      if (item.items && item.items.length > 0) {
        if (enforceLimits) enterBlockDepth(budget);
        stack.push({ items: item.items, index: 0, depth: frame.depth + 1 });
      }
    }
  } finally {
    if (enforceLimits) {
      while (stack.length > 0) {
        stack.pop();
        budget?.exitDepth('block');
      }
    }
  }
  return lines.join('\n');
}
